#!/usr/bin/env bash
# scripts/install-cert-manager.sh — Install cert-manager v1.14 via Helm and wait for CRD readiness
#
# cert-manager provides webhook TLS for cluster operators (CNPG, OpenSearch).
# Tenant TLS is handled by Caddy on-demand TLS — cert-manager is NOT used for
# tenant certificates.
#
# Installs with installCRDs=true, then polls until all cert-manager CRDs reach
# the Established condition before returning. This prevents race conditions when
# subsequent phases rely on cert-manager webhooks.
#
# Called by deploy.sh phase 4. Must be idempotent.

set -euo pipefail

CERT_MANAGER_NAMESPACE="cert-manager"
CERT_MANAGER_HELM_RELEASE="cert-manager"
CERT_MANAGER_VERSION="v1.14.5"
WAIT_TIMEOUT=300  # seconds

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# All cert-manager CRDs that must reach Established status before we proceed
CERT_MANAGER_CRDS=(
  certificaterequests.cert-manager.io
  certificates.cert-manager.io
  challenges.acme.cert-manager.io
  clusterissuers.cert-manager.io
  issuers.cert-manager.io
  orders.acme.cert-manager.io
)

# ── Check if cert-manager is already deployed ─────────────────────────────────
cert_manager_installed() {
  helm status "${CERT_MANAGER_HELM_RELEASE}" -n "${CERT_MANAGER_NAMESPACE}" >/dev/null 2>&1
}

# ── Install cert-manager via Helm ─────────────────────────────────────────────
install_cert_manager() {
  log "Installing cert-manager ${CERT_MANAGER_VERSION} via Helm"

  # Ensure namespace exists (cert-manager chart does not create it when using installCRDs)
  kubectl create namespace "${CERT_MANAGER_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

  # cert-manager images are on quay.io/jetstack — NOT Docker Hub.
  # Do not set mirror.gcr.io overrides (mirror.gcr.io only mirrors Docker Hub).
  helm install "${CERT_MANAGER_HELM_RELEASE}" cert-manager/cert-manager \
    --version "${CERT_MANAGER_VERSION}" \
    --namespace "${CERT_MANAGER_NAMESPACE}" \
    --set installCRDs=true \
    --set global.leaderElection.namespace="${CERT_MANAGER_NAMESPACE}" \
    --set replicaCount=1 \
    --wait=false

  info "cert-manager Helm release created"
}

# ── CRD readiness gate — poll until all cert-manager CRDs are Established ─────
wait_for_crds() {
  log "Waiting for cert-manager CRDs to reach Established status (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local all_ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local pending=0

    for crd in "${CERT_MANAGER_CRDS[@]}"; do
      # Check if the CRD exists and has Established=True condition
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

    info "Waiting... ${pending}/${#CERT_MANAGER_CRDS[@]} CRDs not yet Established"
    sleep 10
  done

  if [[ "${all_ready}" != "true" ]]; then
    err "cert-manager CRDs did not reach Established status within ${WAIT_TIMEOUT}s"
    err "CRD status:"
    for crd in "${CERT_MANAGER_CRDS[@]}"; do
      local status
      status=$(kubectl get crd "${crd}" \
        -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "MISSING")
      err "  ${crd}: ${status}"
    done
    exit 1
  fi

  info "All ${#CERT_MANAGER_CRDS[@]} cert-manager CRDs Established"
}

# ── Webhook pod readiness gate — wait for cert-manager pods to be Running ─────
wait_for_pods() {
  log "Waiting for cert-manager pods to be Running (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local not_running
    not_running=$(kubectl get pods -n "${CERT_MANAGER_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | awk '$3 != "Running" {print}' \
      | wc -l | tr -d ' ')

    local total
    total=$(kubectl get pods -n "${CERT_MANAGER_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | wc -l | tr -d ' ')

    if [[ "${total}" -gt 0 && "${not_running}" -eq 0 ]]; then
      ready=true
      break
    fi

    info "Waiting... cert-manager pods Running: $(( total - not_running ))/${total}"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "cert-manager pods did not become ready within ${WAIT_TIMEOUT}s"
    kubectl get pods -n "${CERT_MANAGER_NAMESPACE}" 2>/dev/null || true
    exit 1
  fi

  local total_running
  total_running=$(kubectl get pods -n "${CERT_MANAGER_NAMESPACE}" \
    --no-headers 2>/dev/null | grep -v "Completed" | wc -l | tr -d ' ')
  info "All ${total_running} cert-manager pod(s) Running"
}

# ── Main ──────────────────────────────────────────────────────────────────────
if cert_manager_installed; then
  info "cert-manager Helm release '${CERT_MANAGER_HELM_RELEASE}' already present in ${CERT_MANAGER_NAMESPACE}"
else
  install_cert_manager
fi

wait_for_crds
wait_for_pods

log "cert-manager phase complete"
