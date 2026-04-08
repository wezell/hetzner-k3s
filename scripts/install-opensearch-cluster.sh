#!/usr/bin/env bash
# scripts/install-opensearch-cluster.sh — Deploy shared OpenSearch cluster CR
#
# Applies the shared OpenSearchCluster resource that all tenant environments use
# for full-text search indices.  Per-tenant users and index prefixes are created
# by tenant-add.sh after this cluster reaches phase=RUNNING.
#
# Prerequisites:
#   - OpenSearch operator Running (phase 8 — install-opensearch.sh)
#   - All 6 opensearch-operator CRDs in Established status
#
# No secrets required — the cluster CR has no credential placeholders.
# Called by deploy.sh phase 9.  Must be idempotent (kubectl apply guard).
#
# Health validation sequence:
#   1. Verify operator CRDs are Established
#   2. Verify operator pod(s) are Running + Ready
#   3. Apply manifests/opensearch-cluster.yaml (skip if cluster already exists)
#   4. Poll status.phase until == "RUNNING" (timeout: 600s)
#   5. Report cluster service endpoint for tenant-add.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/../manifests/opensearch-cluster.yaml"
OPENSEARCH_NAMESPACE="opensearch"
CLUSTER_NAME="opensearch"
WAIT_TIMEOUT=600  # seconds — image pull + 3-node quorum formation takes time

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# Core operator CRDs that must be Established before applying cluster resources
OPENSEARCH_OPERATOR_CRDS=(
  opensearchclusters.opensearch.opster.io
  opensearchusers.opensearch.opster.io
  opensearchroles.opensearch.opster.io
  opensearchindextemplates.opensearch.opster.io
  opensearchactiongroups.opensearch.opster.io
  opensearchtenants.opensearch.opster.io
)

# ── Verify manifest exists ────────────────────────────────────────────────────
if [[ ! -f "${MANIFEST}" ]]; then
  err "Manifest not found: ${MANIFEST}"
  exit 1
fi

# ── Gate 1: Operator CRDs Established ────────────────────────────────────────
log "Verifying OpenSearch operator CRDs are Established..."
missing_crds=0
for crd in "${OPENSEARCH_OPERATOR_CRDS[@]}"; do
  status=$(kubectl get crd "${crd}" \
    -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "")
  if [[ "${status}" != "True" ]]; then
    err "CRD not Established: ${crd} (status: '${status:-missing}')"
    missing_crds=$(( missing_crds + 1 ))
  fi
done

if [[ "${missing_crds}" -gt 0 ]]; then
  err "${missing_crds} CRD(s) not Established — run install-opensearch.sh (deploy.sh phase 8) first"
  exit 1
fi
info "All ${#OPENSEARCH_OPERATOR_CRDS[@]} operator CRDs Established ✓"

# ── Gate 2: Operator pods Running + Ready ─────────────────────────────────────
log "Verifying OpenSearch operator pod is Running and Ready..."
not_ready=$(kubectl get pods -n "${OPENSEARCH_NAMESPACE}" \
  --no-headers 2>/dev/null \
  | grep -v "Completed" \
  | awk '$3 != "Running" {print}' \
  | wc -l | tr -d ' ')

if [[ "${not_ready}" -gt 0 ]]; then
  err "OpenSearch operator has ${not_ready} non-Running pod(s) in namespace '${OPENSEARCH_NAMESPACE}'"
  kubectl get pods -n "${OPENSEARCH_NAMESPACE}" 2>/dev/null || true
  err "Wait for install-opensearch.sh to complete before running this script"
  exit 1
fi

if ! kubectl wait pod \
    -n "${OPENSEARCH_NAMESPACE}" \
    --all \
    --for=condition=Ready \
    --timeout=30s >/dev/null 2>&1; then
  err "OpenSearch operator pods are not Ready — check 'kubectl get pods -n ${OPENSEARCH_NAMESPACE}'"
  exit 1
fi
info "OpenSearch operator pods Running and Ready ✓"

# ── Apply shared OpenSearchCluster CR ─────────────────────────────────────────
log "Applying shared OpenSearchCluster manifest..."
info "  Source: ${MANIFEST}"

if kubectl get opensearchcluster "${CLUSTER_NAME}" \
    -n "${OPENSEARCH_NAMESPACE}" >/dev/null 2>&1; then
  info "OpenSearchCluster '${CLUSTER_NAME}' already exists — skipping apply (idempotent)"
else
  kubectl apply -f "${MANIFEST}"
  info "OpenSearchCluster '${CLUSTER_NAME}' created"
fi

# ── Gate 3: Cluster phase=RUNNING ────────────────────────────────────────────
log "Waiting for OpenSearchCluster '${CLUSTER_NAME}' to reach phase=RUNNING (timeout: ${WAIT_TIMEOUT}s)..."
info "  Note: first startup pulls the OpenSearch image and forms a 3-node quorum."
info "  This typically takes 4-10 minutes."

deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
cluster_ready=false

while [[ $(date +%s) -lt ${deadline} ]]; do
  phase=$(kubectl get opensearchcluster "${CLUSTER_NAME}" \
    -n "${OPENSEARCH_NAMESPACE}" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")

  if [[ "${phase}" == "RUNNING" ]]; then
    cluster_ready=true
    break
  fi

  # Also check if all nodes are Ready as a fallback (phase label varies by operator version)
  running_nodes=$(kubectl get pods -n "${OPENSEARCH_NAMESPACE}" \
    --no-headers 2>/dev/null \
    | grep "opensearch-masters" \
    | awk '$3 == "Running" {print}' \
    | wc -l | tr -d ' ')

  if [[ "${running_nodes}" -ge 3 ]]; then
    if kubectl wait pod \
        -n "${OPENSEARCH_NAMESPACE}" \
        -l "opster.io/cluster=${CLUSTER_NAME}" \
        --for=condition=Ready \
        --timeout=10s >/dev/null 2>&1; then
      info "All 3 OpenSearch node pods are Ready — cluster is functional"
      cluster_ready=true
      break
    fi
  fi

  info "Cluster phase: '${phase:-pending}' | Running nodes: ${running_nodes}/3 — retrying in 15s..."
  sleep 15
done

if [[ "${cluster_ready}" != "true" ]]; then
  err "OpenSearchCluster '${CLUSTER_NAME}' did not reach phase=RUNNING within ${WAIT_TIMEOUT}s"
  err ""
  err "Cluster status:"
  kubectl get opensearchcluster "${CLUSTER_NAME}" -n "${OPENSEARCH_NAMESPACE}" 2>/dev/null || true
  err ""
  err "Pod status:"
  kubectl get pods -n "${OPENSEARCH_NAMESPACE}" 2>/dev/null || true
  err ""
  err "Recent events:"
  kubectl get events -n "${OPENSEARCH_NAMESPACE}" \
    --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || true
  err ""
  err "Operator logs (last 50 lines):"
  kubectl logs -n "${OPENSEARCH_NAMESPACE}" \
    -l "app.kubernetes.io/name=opensearch-operator" \
    --tail=50 2>/dev/null || true
  exit 1
fi

# ── Report cluster service endpoint ───────────────────────────────────────────
svc_name="${CLUSTER_NAME}"  # operator creates a service named after the cluster
svc_ip=$(kubectl get svc "${svc_name}" -n "${OPENSEARCH_NAMESPACE}" \
  -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "unknown")

info ""
info "OpenSearch cluster endpoint:"
info "  Service : ${svc_name}.${OPENSEARCH_NAMESPACE}.svc.cluster.local"
info "  ClusterIP: ${svc_ip}:9200"
info ""
info "Tenant users and index prefixes are provisioned by tenant-add.sh."
info "Connection pattern for dotCMS:"
info "  http://${svc_name}.${OPENSEARCH_NAMESPACE}.svc.cluster.local:9200"

log "OpenSearch cluster phase complete"
