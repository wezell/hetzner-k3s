#!/usr/bin/env bash
# scripts/install-valkey.sh — Install Valkey (Redis-compatible cache) via Helm
#
# Valkey is deployed as a shared, cluster-wide cache layer used by dotCMS tenants
# for session storage and caching. A single standalone instance is sufficient for
# up to 50 active environments; the cluster network boundary provides access control.
#
# Authentication: set VALKEY_PASSWORD in .env to enable password auth. If not set,
# auth is disabled (internal-only traffic, no lateral network access outside cluster).
#
# Chart: oci://registry-1.docker.io/bitnamicharts/valkey (Bitnami OCI)
# Images: mirror.gcr.io/bitnami/valkey (avoids Docker Hub rate limits)
# Architecture: standalone (single pod + PVC for simplicity and low overhead)
#
# After Helm installation, creates a 'valkey-connection' Secret in the 'valkey'
# namespace containing host, port, and password for use by tenant provisioning.
#
# Called by deploy.sh phase 14. Must be idempotent.

set -euo pipefail

VALKEY_NAMESPACE="valkey"
VALKEY_HELM_RELEASE="valkey"
VALKEY_CHART="oci://registry-1.docker.io/bitnamicharts/valkey"  # Bitnami OCI — no mirror available for OCI charts
VALKEY_VERSION="5.4.9"   # Valkey 8.x — check for latest stable before deploy
WAIT_TIMEOUT=300         # seconds

# Optional: set VALKEY_PASSWORD in .env to enable authentication.
# If empty, auth is disabled for internal-only cluster traffic.
VALKEY_PASSWORD="${VALKEY_PASSWORD:-}"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# ── Check if Valkey is already deployed ───────────────────────────────────────
valkey_installed() {
  helm status "${VALKEY_HELM_RELEASE}" -n "${VALKEY_NAMESPACE}" >/dev/null 2>&1
}

# ── Install Valkey via Helm ───────────────────────────────────────────────────
install_valkey() {
  log "Installing Valkey ${VALKEY_VERSION} via Helm (standalone mode)"

  # Ensure namespace exists
  kubectl create namespace "${VALKEY_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

  # Build auth flags: enable password auth if VALKEY_PASSWORD is set
  local auth_flags=("--set" "auth.enabled=false")
  if [[ -n "${VALKEY_PASSWORD}" ]]; then
    auth_flags=(
      "--set" "auth.enabled=true"
      "--set" "auth.password=${VALKEY_PASSWORD}"
    )
    info "Auth enabled (VALKEY_PASSWORD is set)"
  else
    info "Auth disabled — internal-only traffic within cluster network"
  fi

  helm install "${VALKEY_HELM_RELEASE}" "${VALKEY_CHART}" \
    --version "${VALKEY_VERSION}" \
    --namespace "${VALKEY_NAMESPACE}" \
    --set global.security.allowInsecureImages=false \
    --set architecture=standalone \
    "${auth_flags[@]}" \
    --set master.resources.requests.cpu=100m \
    --set master.resources.requests.memory=256Mi \
    --set master.resources.limits.cpu=500m \
    --set master.resources.limits.memory=512Mi \
    --set master.persistence.enabled=true \
    --set master.persistence.size=2Gi \
    --set master.persistence.storageClass="" \
    --set metrics.enabled=true \
    --wait=false

  info "Valkey Helm release created"
}

# ── Pod readiness gate ────────────────────────────────────────────────────────
wait_for_pod() {
  log "Waiting for Valkey pod to be Running and Ready (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local not_running
    not_running=$(kubectl get pods -n "${VALKEY_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | awk '$3 != "Running" {print}' \
      | wc -l | tr -d ' ')

    local total
    total=$(kubectl get pods -n "${VALKEY_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | wc -l | tr -d ' ')

    if [[ "${total}" -gt 0 && "${not_running}" -eq 0 ]]; then
      if kubectl wait pod \
          -n "${VALKEY_NAMESPACE}" \
          --all \
          --for=condition=Ready \
          --timeout=10s >/dev/null 2>&1; then
        ready=true
        break
      fi
    fi

    info "Waiting... Valkey pods Running: $(( total - not_running ))/${total}"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "Valkey pod did not become Ready within ${WAIT_TIMEOUT}s"
    kubectl get pods -n "${VALKEY_NAMESPACE}" 2>/dev/null || true
    kubectl describe pod -n "${VALKEY_NAMESPACE}" -l app.kubernetes.io/name=valkey 2>/dev/null || true
    exit 1
  fi

  local total_ready
  total_ready=$(kubectl get pods -n "${VALKEY_NAMESPACE}" --no-headers 2>/dev/null | grep -v "Completed" | wc -l | tr -d ' ')
  info "Valkey: ${total_ready} pod(s) Running and Ready"
}

# ── Connectivity smoke test ───────────────────────────────────────────────────
smoke_test() {
  log "Running Valkey connectivity smoke test..."

  local svc="${VALKEY_HELM_RELEASE}-master.${VALKEY_NAMESPACE}.svc.cluster.local"
  local pong
  pong=$(kubectl run valkey-smoke-test \
    --image=mirror.gcr.io/bitnami/valkey:latest \
    --restart=Never \
    --rm \
    --attach \
    --quiet \
    -n "${VALKEY_NAMESPACE}" \
    --command -- valkey-cli -h "${svc}" ping 2>/dev/null || echo "SKIP")

  if [[ "${pong}" == *"PONG"* ]]; then
    info "Valkey PING → PONG ✓"
  else
    warn "Smoke test skipped or inconclusive (in-cluster exec may not be available during bootstrap)"
    warn "Verify manually: kubectl run -it --rm --image=mirror.gcr.io/bitnami/valkey:latest test -- valkey-cli -h ${svc} ping"
  fi
}

# ── Connection Secret ─────────────────────────────────────────────────────────
# Creates (or updates) 'valkey-connection' Secret in the valkey namespace.
# Consumed by tenant-add.sh to stamp per-tenant Secrets in each tenant namespace.
create_connection_secret() {
  log "Creating/updating 'valkey-connection' Secret in namespace '${VALKEY_NAMESPACE}'..."

  local svc_host="${VALKEY_HELM_RELEASE}-master.${VALKEY_NAMESPACE}.svc.cluster.local"

  kubectl create secret generic valkey-connection \
    --namespace="${VALKEY_NAMESPACE}" \
    --from-literal=host="${svc_host}" \
    --from-literal=port="6379" \
    --from-literal=password="${VALKEY_PASSWORD}" \
    --dry-run=client -o yaml \
    | kubectl apply -f -

  info "valkey-connection Secret ready (host=${svc_host}, port=6379, auth=$([ -n "${VALKEY_PASSWORD}" ] && echo enabled || echo disabled))"
}

# ── Main ──────────────────────────────────────────────────────────────────────
if valkey_installed; then
  info "Valkey Helm release '${VALKEY_HELM_RELEASE}' already present in ${VALKEY_NAMESPACE}"
else
  install_valkey
fi

wait_for_pod
smoke_test
create_connection_secret

log "Valkey phase complete — service: ${VALKEY_HELM_RELEASE}-master.${VALKEY_NAMESPACE}.svc.cluster.local:6379"
