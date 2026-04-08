#!/usr/bin/env bash
# scripts/install-cnpg.sh — Install CloudNativePG operator via Helm and wait for readiness
#
# CloudNativePG manages per-tenant Postgres clusters (one DB per tenant environment).
# The operator is installed cluster-wide in cnpg-system; individual Cluster resources
# are created per-tenant by tenant-add.sh.
#
# Installs the operator, waits for the CRDs to reach Established status, then
# waits for the controller pod to reach Running/Ready. This prevents race conditions
# when subsequent phases create Cluster resources.
#
# Called by deploy.sh phase 6. Must be idempotent.

set -euo pipefail

CNPG_NAMESPACE="cnpg-system"
CNPG_HELM_RELEASE="cnpg"
CNPG_VERSION="0.22.1"   # corresponds to CloudNativePG operator v1.22.x
WAIT_TIMEOUT=300         # seconds

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# Core CNPG CRDs that must reach Established status before proceeding
CNPG_CRDS=(
  clusters.postgresql.cnpg.io
  backups.postgresql.cnpg.io
  scheduledbackups.postgresql.cnpg.io
  poolers.postgresql.cnpg.io
)

# ── Check if CNPG is already deployed ────────────────────────────────────────
cnpg_installed() {
  helm status "${CNPG_HELM_RELEASE}" -n "${CNPG_NAMESPACE}" >/dev/null 2>&1
}

# ── Install CNPG via Helm ─────────────────────────────────────────────────────
install_cnpg() {
  log "Installing CloudNativePG operator ${CNPG_VERSION} via Helm"

  # Ensure namespace exists
  kubectl create namespace "${CNPG_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

  helm install "${CNPG_HELM_RELEASE}" cnpg/cloudnative-pg \
    --version "${CNPG_VERSION}" \
    --namespace "${CNPG_NAMESPACE}" \
    --set image.repository=ghcr.io/cloudnative-pg/cloudnative-pg \
    --set replicaCount=1 \
    --wait=false

  info "CloudNativePG Helm release created"
}

# ── CRD readiness gate ────────────────────────────────────────────────────────
wait_for_crds() {
  log "Waiting for CNPG CRDs to reach Established status (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local all_ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local pending=0

    for crd in "${CNPG_CRDS[@]}"; do
      local status
      status=$(kubectl get crd "${crd}" \
        -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "Missing")

      if [[ "${status}" != "True" ]]; then
        pending=$(( pending + 1 ))
      fi
    done

    if [[ "${pending}" -eq 0 ]]; then
      all_ready=true
      break
    fi

    info "Waiting... ${pending}/${#CNPG_CRDS[@]} CRDs not yet Established"
    sleep 10
  done

  if [[ "${all_ready}" != "true" ]]; then
    err "CNPG CRDs did not reach Established status within ${WAIT_TIMEOUT}s"
    for crd in "${CNPG_CRDS[@]}"; do
      local status
      status=$(kubectl get crd "${crd}" \
        -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "MISSING")
      err "  ${crd}: ${status}"
    done
    exit 1
  fi

  info "All ${#CNPG_CRDS[@]} CNPG CRDs Established"
}

# ── Controller pod readiness gate ─────────────────────────────────────────────
wait_for_controller() {
  log "Waiting for CNPG controller pod to be Running (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local not_running
    not_running=$(kubectl get pods -n "${CNPG_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | awk '$3 != "Running" {print}' \
      | wc -l | tr -d ' ')

    local total
    total=$(kubectl get pods -n "${CNPG_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | wc -l | tr -d ' ')

    if [[ "${total}" -gt 0 && "${not_running}" -eq 0 ]]; then
      # Also verify containers are Ready via kubectl wait
      if kubectl wait pod \
          -n "${CNPG_NAMESPACE}" \
          --all \
          --for=condition=Ready \
          --timeout=10s >/dev/null 2>&1; then
        ready=true
        break
      fi
    fi

    info "Waiting... CNPG controller pods Running: $(( total - not_running ))/${total}"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "CNPG controller pod did not become Ready within ${WAIT_TIMEOUT}s"
    kubectl get pods -n "${CNPG_NAMESPACE}" 2>/dev/null || true
    exit 1
  fi

  local total_ready
  total_ready=$(kubectl get pods -n "${CNPG_NAMESPACE}" --no-headers 2>/dev/null | grep -v "Completed" | wc -l | tr -d ' ')
  info "CNPG controller: ${total_ready} pod(s) Running and Ready"
}

# ── Main ──────────────────────────────────────────────────────────────────────
if cnpg_installed; then
  info "CloudNativePG Helm release '${CNPG_HELM_RELEASE}' already present in ${CNPG_NAMESPACE}"
else
  install_cnpg
fi

wait_for_crds
wait_for_controller

log "CloudNativePG operator phase complete"
