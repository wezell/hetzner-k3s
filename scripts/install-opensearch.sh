#!/usr/bin/env bash
# scripts/install-opensearch.sh — Install OpenSearch operator via Helm and wait for readiness
#
# The opensearch-operator (by Opster) manages OpenSearch clusters declared as
# OpenSearchCluster CRs.  A single shared cluster is deployed in the opensearch
# namespace; per-tenant users/indices are created at tenant-add time.
#
# Install sequence:
#   1. Install the Helm chart (operator only — no cluster CR yet)
#   2. Wait for operator CRDs to reach Established status
#   3. Wait for the operator controller pod to be Running + Ready
#   4. Apply the shared OpenSearchCluster CR
#   5. Wait for the cluster to report a Ready condition
#
# Called by deploy.sh phase 7.  Must be idempotent.

set -euo pipefail

OPENSEARCH_NAMESPACE="opensearch"
OPENSEARCH_HELM_RELEASE="opensearch-operator"
OPENSEARCH_OPERATOR_VERSION="2.7.0"
OPENSEARCH_CLUSTER_VERSION="1.3.19"
WAIT_TIMEOUT=600  # seconds — OpenSearch cluster boot is slow

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# Core OpenSearch operator CRDs that must reach Established status before
# applying any OpenSearchCluster or OpenSearchUser resources.
OPENSEARCH_OPERATOR_CRDS=(
  opensearchclusters.opensearch.opster.io
  opensearchusers.opensearch.opster.io
  opensearchroles.opensearch.opster.io
  opensearchindextemplates.opensearch.opster.io
  opensearchactiongroups.opensearch.opster.io
  opensearchtenants.opensearch.opster.io
)

# ── Check if operator Helm release already exists ────────────────────────────
operator_installed() {
  helm status "${OPENSEARCH_HELM_RELEASE}" -n "${OPENSEARCH_NAMESPACE}" >/dev/null 2>&1
}

# ── Install operator via Helm ─────────────────────────────────────────────────
install_operator() {
  log "Installing OpenSearch operator ${OPENSEARCH_OPERATOR_VERSION} via Helm"

  # Ensure namespace exists
  kubectl create namespace "${OPENSEARCH_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

  helm install "${OPENSEARCH_HELM_RELEASE}" opensearch/opensearch-operator \
    --version "${OPENSEARCH_OPERATOR_VERSION}" \
    --namespace "${OPENSEARCH_NAMESPACE}" \
    --set kubeRbacProxy.image.repository=quay.io/brancz/kube-rbac-proxy \
    --set kubeRbacProxy.image.tag=v0.18.1 \
    --wait=false

  info "OpenSearch operator Helm release created"
}

# ── CRD readiness gate ────────────────────────────────────────────────────────
wait_for_crds() {
  log "Waiting for OpenSearch operator CRDs to reach Established status (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local all_ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local pending=0

    for crd in "${OPENSEARCH_OPERATOR_CRDS[@]}"; do
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

    info "Waiting... ${pending}/${#OPENSEARCH_OPERATOR_CRDS[@]} CRDs not yet Established"
    sleep 10
  done

  if [[ "${all_ready}" != "true" ]]; then
    err "OpenSearch operator CRDs did not reach Established status within ${WAIT_TIMEOUT}s"
    for crd in "${OPENSEARCH_OPERATOR_CRDS[@]}"; do
      local status
      status=$(kubectl get crd "${crd}" \
        -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "MISSING")
      err "  ${crd}: ${status}"
    done
    exit 1
  fi

  info "All ${#OPENSEARCH_OPERATOR_CRDS[@]} OpenSearch operator CRDs Established"
}

# ── Operator controller pod readiness gate ────────────────────────────────────
wait_for_operator_pod() {
  log "Waiting for OpenSearch operator pod to be Running (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local not_running
    not_running=$(kubectl get pods -n "${OPENSEARCH_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | awk '$3 != "Running" {print}' \
      | wc -l | tr -d ' ')

    local total
    total=$(kubectl get pods -n "${OPENSEARCH_NAMESPACE}" \
      --no-headers 2>/dev/null \
      | grep -v "Completed" \
      | wc -l | tr -d ' ')

    if [[ "${total}" -gt 0 && "${not_running}" -eq 0 ]]; then
      if kubectl wait pod \
          -n "${OPENSEARCH_NAMESPACE}" \
          --all \
          --for=condition=Ready \
          --timeout=10s >/dev/null 2>&1; then
        ready=true
        break
      fi
    fi

    info "Waiting... OpenSearch operator pods Running: $(( total - not_running ))/${total}"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "OpenSearch operator pod did not become Ready within ${WAIT_TIMEOUT}s"
    kubectl get pods -n "${OPENSEARCH_NAMESPACE}" 2>/dev/null || true
    exit 1
  fi

  local total_ready
  total_ready=$(kubectl get pods -n "${OPENSEARCH_NAMESPACE}" --no-headers 2>/dev/null | grep -v "Completed" | wc -l | tr -d ' ')
  info "OpenSearch operator: ${total_ready} pod(s) Running and Ready"
}

# ── Main ──────────────────────────────────────────────────────────────────────
# This script installs and validates the OpenSearch OPERATOR only.
# The shared OpenSearchCluster CR is applied by install-opensearch-cluster.sh
# (deploy.sh phase 9) so the cluster manifest can be managed independently.
if operator_installed; then
  info "OpenSearch operator Helm release '${OPENSEARCH_HELM_RELEASE}' already present in ${OPENSEARCH_NAMESPACE}"
else
  install_operator
fi

# CRD gate — must complete before any OpenSearchCluster or OpenSearchUser CRs
wait_for_crds

# Operator pod gate — must be Running before the cluster CR can be reconciled
wait_for_operator_pod

log "OpenSearch operator phase complete"
info ""
info "Next step: run install-opensearch-cluster.sh (deploy.sh phase 9)"
info "  to deploy the shared OpenSearchCluster and wait for phase=RUNNING."
