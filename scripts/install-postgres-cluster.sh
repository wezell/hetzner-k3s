#!/usr/bin/env bash
# scripts/install-postgres-cluster.sh — Deploy shared CloudNativePG Postgres cluster
#
# Applies the shared 3-instance PostgreSQL cluster that all tenant environments share.
# Per-tenant databases and roles are created by tenant-add.sh after this cluster is Running.
#
# Prerequisites:
#   - CNPG operator Running (phase 6 — install-cnpg.sh)
#   - Wasabi S3 bucket for WAL archiving configured in .env
#   - hcloud-volumes StorageClass available (k3s default with Hetzner CSI)
#
# Required env vars (source .env before running):
#   WASABI_ACCESS_KEY    — Wasabi S3 access key for WAL backup
#   WASABI_SECRET_KEY    — Wasabi S3 secret key
#   WASABI_BUCKET        — Wasabi bucket name (e.g. dotcms-pg-backup)
#   WASABI_REGION        — Wasabi region (e.g. us-east-1)
#
# Called by deploy.sh phase 9. Must be idempotent (kubectl apply).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/../manifests/postgres-cluster.yaml"
WAIT_TIMEOUT=600   # 10 minutes — pulling the CNPG image + 3 instances starting takes time
CLUSTER_NS="postgres"
CLUSTER_NAME="postgres"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# ── Validate required env vars ─────────────────────────────────────────────────
for var in WASABI_ACCESS_KEY WASABI_SECRET_KEY WASABI_BUCKET WASABI_REGION; do
  if [[ -z "${!var:-}" ]]; then
    err "Required variable not set: ${var} (source .env first)"
    exit 1
  fi
done

# ── Verify CNPG operator CRDs are ready before applying cluster resources ──────
log "Verifying CNPG operator is installed..."
if ! kubectl get crd clusters.postgresql.cnpg.io >/dev/null 2>&1; then
  err "CNPG CRD 'clusters.postgresql.cnpg.io' not found"
  err "Run install-cnpg.sh (deploy.sh phase 6) first"
  exit 1
fi

crd_status=$(kubectl get crd clusters.postgresql.cnpg.io \
  -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "")
if [[ "${crd_status}" != "True" ]]; then
  err "CNPG Cluster CRD is not yet Established (status: ${crd_status})"
  err "Wait for install-cnpg.sh to complete before running this script"
  exit 1
fi
info "CNPG Cluster CRD Established ✓"

# ── Apply the shared Postgres cluster manifest ─────────────────────────────────
log "Applying shared Postgres cluster manifest (namespace: ${CLUSTER_NS})"

if [[ ! -f "${MANIFEST}" ]]; then
  err "Manifest not found: ${MANIFEST}"
  exit 1
fi

# envsubst replaces ${WASABI_ACCESS_KEY}, ${WASABI_SECRET_KEY}, ${WASABI_BUCKET}, ${WASABI_REGION}
envsubst '${WASABI_ACCESS_KEY} ${WASABI_SECRET_KEY} ${WASABI_BUCKET} ${WASABI_REGION}' \
  < "${MANIFEST}" | kubectl apply -f -

info "Manifest applied"

# ── Wait for Cluster to reach phase=Healthy ────────────────────────────────────
log "Waiting for CNPG Cluster '${CLUSTER_NAME}' to reach phase=Healthy (timeout: ${WAIT_TIMEOUT}s)..."
info "  Note: first startup pulls the PostgreSQL image and initialises 3 instances."
info "  This typically takes 3-8 minutes."

deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
healthy=false

while [[ $(date +%s) -lt ${deadline} ]]; do
  phase=$(kubectl get cluster "${CLUSTER_NAME}" \
    -n "${CLUSTER_NS}" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")

  ready=$(kubectl get cluster "${CLUSTER_NAME}" \
    -n "${CLUSTER_NS}" \
    -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo "0")

  instances=$(kubectl get cluster "${CLUSTER_NAME}" \
    -n "${CLUSTER_NS}" \
    -o jsonpath='{.spec.instances}' 2>/dev/null || echo "3")

  if [[ "${phase}" == "Cluster in healthy state" || "${phase}" == "Healthy" ]]; then
    healthy=true
    break
  fi

  # Also accept: all instances ready even if phase string varies between CNPG versions
  if [[ "${ready}" == "${instances}" && "${instances}" != "0" ]]; then
    info "All ${instances} instances Ready — cluster is functional"
    healthy=true
    break
  fi

  info "Cluster phase: '${phase:-pending}' | Ready: ${ready:-0}/${instances} — waiting 20s..."
  sleep 20
done

if [[ "${healthy}" != "true" ]]; then
  err "Postgres cluster '${CLUSTER_NAME}' did not reach Healthy state within ${WAIT_TIMEOUT}s"
  err ""
  err "Cluster status:"
  kubectl get cluster "${CLUSTER_NAME}" -n "${CLUSTER_NS}" 2>/dev/null || true
  err ""
  err "Pod status:"
  kubectl get pods -n "${CLUSTER_NS}" 2>/dev/null || true
  err ""
  err "Recent events:"
  kubectl get events -n "${CLUSTER_NS}" --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || true
  exit 1
fi

# ── Report primary endpoint ────────────────────────────────────────────────────
primary_svc=$(kubectl get svc -n "${CLUSTER_NS}" \
  -o jsonpath='{.items[?(@.metadata.name=="postgres-rw")].metadata.name}' 2>/dev/null || echo "")

if [[ -n "${primary_svc}" ]]; then
  primary_ip=$(kubectl get svc postgres-rw -n "${CLUSTER_NS}" \
    -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "unknown")
  info "Primary (rw) service: postgres-rw.${CLUSTER_NS}.svc.cluster.local (${primary_ip}:5432)"
else
  warn "postgres-rw service not found — check cluster status manually"
fi

# Report how many ready instances
ready_final=$(kubectl get cluster "${CLUSTER_NAME}" \
  -n "${CLUSTER_NS}" \
  -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo "unknown")
info "Ready instances: ${ready_final}/3"

log "Shared Postgres cluster phase complete"
info ""
info "Tenant databases are provisioned by tenant-add.sh, not here."
info "Connection string pattern:"
info "  postgresql://<user>:<pass>@postgres-rw.postgres.svc.cluster.local:5432/<dbname>"
