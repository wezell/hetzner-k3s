#!/usr/bin/env bash
# destroy.sh — Tear down all cluster-wide infrastructure installed by deploy.sh
#
# Usage:
#   source .env && ./destroy.sh
#
# This script removes all cluster-wide components in reverse dependency order:
#   1. Tenant namespaces (warn + skip unless --force-tenants)
#   2. CNPG Cluster and OpenSearch custom resources (operator-managed cleanup)
#   3. Helm releases (reverse install order)
#   4. StorageClass, ClusterIssuers, and other cluster-scoped resources
#   5. Namespaces
#   6. Orphaned CRDs (optional, with --purge-crds)
#
# Flags:
#   --force-tenants   Delete all tenant namespaces before proceeding (DESTRUCTIVE)
#   --purge-crds      Also remove CRDs installed by operators
#   --dry-run         Print actions without executing them
#
# Required env (sourced from .env):
#   KUBECONFIG (or default ~/.kube/config)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FORCE_TENANTS=false
PURGE_CRDS=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --force-tenants) FORCE_TENANTS=true ;;
    --purge-crds)    PURGE_CRDS=true ;;
    --dry-run)       DRY_RUN=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# Load .env if present and not already sourced
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
fi

export KUBECONFIG="${KUBECONFIG:-${HOME}/.kube/config}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "  [destroy] $*"; }
warn() { echo "  [destroy] WARNING: $*" >&2; }

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

kubectl_delete() {
  # Deletes a resource, silently ignoring not-found errors
  run kubectl delete --ignore-not-found=true "$@"
}

helm_uninstall() {
  local release=$1
  local namespace=$2
  if helm status "${release}" -n "${namespace}" &>/dev/null; then
    log "Uninstalling Helm release: ${release} (namespace: ${namespace})"
    run helm uninstall "${release}" -n "${namespace}" --wait --timeout 5m || \
      warn "Helm uninstall of ${release} exited non-zero — continuing"
  else
    log "Helm release ${release} not found in ${namespace} — skipping"
  fi
}

ns_exists() {
  kubectl get namespace "$1" &>/dev/null
}

delete_ns() {
  local ns=$1
  if ns_exists "${ns}"; then
    log "Deleting namespace: ${ns}"
    run kubectl delete namespace "${ns}" --timeout=120s || \
      warn "Namespace ${ns} deletion timed out — may still be terminating"
  else
    log "Namespace ${ns} not found — skipping"
  fi
}

# ─── Step 0: Pre-flight checks ────────────────────────────────────────────────

log "Pre-flight: verifying cluster connectivity"
if ! kubectl cluster-info &>/dev/null; then
  echo "ERROR: Cannot connect to cluster. Check KUBECONFIG." >&2
  exit 1
fi

# ─── Step 1: Tenant namespace guard ───────────────────────────────────────────

log "Checking for active tenant namespaces..."

# Tenant namespaces follow the pattern: <tenant>-<env> and are NOT system namespaces
SYSTEM_NAMESPACES="default|kube-system|kube-public|kube-node-lease|cnpg-system|postgres|opensearch|monitoring|caddy|valkey|cert-manager"
TENANT_NAMESPACES=$(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | \
  grep -vE "^(${SYSTEM_NAMESPACES})$" | \
  grep -E '^[a-z0-9]+-[a-z0-9]+$' || true)

if [[ -n "${TENANT_NAMESPACES}" ]]; then
  if [[ "${FORCE_TENANTS}" == "true" ]]; then
    warn "Deleting all tenant namespaces: ${TENANT_NAMESPACES}"
    for ns in ${TENANT_NAMESPACES}; do
      # Run tenant-remove.sh if available, else raw delete
      if [[ -x "${SCRIPT_DIR}/tenant-remove.sh" ]]; then
        TENANT="${ns%%-*}"
        ENV="${ns#*-}"
        log "Running tenant-remove.sh for ${TENANT} ${ENV}"
        run "${SCRIPT_DIR}/tenant-remove.sh" "${TENANT}" "${ENV}" || \
          warn "tenant-remove.sh failed for ${TENANT}-${ENV} — forcing namespace delete"
        run kubectl delete namespace "${ns}" --ignore-not-found=true --timeout=60s || true
      else
        run kubectl delete namespace "${ns}" --ignore-not-found=true --timeout=60s || true
      fi
    done
  else
    echo "" >&2
    echo "  ERROR: Active tenant namespaces detected:" >&2
    echo "${TENANT_NAMESPACES}" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Run tenant-remove.sh for each tenant first, or use --force-tenants to delete all." >&2
    echo "" >&2
    exit 1
  fi
else
  log "No active tenant namespaces found — proceeding"
fi

# ─── Step 2: Delete CNPG custom resources (let operator clean up gracefully) ──

log "Removing CNPG ScheduledBackups..."
kubectl_delete scheduledbackup -n postgres --all 2>/dev/null || true

log "Removing CNPG Cluster (postgres)..."
kubectl_delete cluster postgres -n postgres 2>/dev/null || true

# Wait briefly for CNPG to reconcile deletions before removing the operator
if ns_exists postgres; then
  log "Waiting for CNPG Cluster deletion (up to 60s)..."
  run kubectl wait --for=delete cluster/postgres -n postgres --timeout=60s 2>/dev/null || \
    warn "CNPG Cluster did not delete cleanly — continuing anyway"
fi

# ─── Step 3: Delete OpenSearch custom resources ────────────────────────────────

log "Removing OpenSearch Cluster..."
kubectl_delete opensearchcluster opensearch -n opensearch 2>/dev/null || true

if ns_exists opensearch; then
  log "Waiting for OpenSearch Cluster deletion (up to 90s)..."
  run kubectl wait --for=delete opensearchcluster/opensearch -n opensearch --timeout=90s 2>/dev/null || \
    warn "OpenSearch Cluster did not delete cleanly — continuing anyway"
fi

# ─── Step 4: Uninstall Helm releases (reverse install order) ──────────────────

log "Uninstalling Helm releases..."

# Monitoring stack (depends on nothing critical)
helm_uninstall kube-prometheus-stack monitoring

# Descheduler
helm_uninstall descheduler kube-system

# Valkey
helm_uninstall valkey valkey

# Caddy ingress (remove last user-facing component)
helm_uninstall caddy caddy

# OpenSearch operator (after cluster CR is gone)
helm_uninstall opensearch-operator opensearch

# CNPG operator (after cluster CR is gone)
helm_uninstall cnpg cnpg-system

# csi-s3 driver (after all PVCs are released by tenant removal)
helm_uninstall csi-s3 kube-system

# cert-manager (after ClusterIssuers removed below)
helm_uninstall cert-manager cert-manager

# ─── Step 5: Remove cluster-scoped resources ──────────────────────────────────

log "Removing StorageClass: s3-fuse..."
kubectl_delete storageclass s3-fuse

log "Removing ClusterIssuers..."
kubectl_delete clusterissuer letsencrypt-prod letsencrypt-staging 2>/dev/null || true

log "Removing cluster-wide Secrets (csi-s3, wasabi backup creds)..."
kubectl_delete secret csi-s3-secret -n kube-system 2>/dev/null || true
kubectl_delete secret wasabi-backup-creds -n postgres 2>/dev/null || true

# ─── Step 6: Delete namespaces ────────────────────────────────────────────────

log "Deleting infrastructure namespaces..."
delete_ns monitoring
delete_ns valkey
delete_ns caddy
delete_ns cert-manager
delete_ns opensearch
delete_ns postgres
delete_ns cnpg-system

# ─── Step 7: Purge CRDs (opt-in) ──────────────────────────────────────────────

if [[ "${PURGE_CRDS}" == "true" ]]; then
  warn "Purging CRDs installed by operators..."

  log "Removing CNPG CRDs..."
  run kubectl get crd -o name | grep "cnpg\|postgresql.cnpg.io" | \
    xargs -r run kubectl delete --ignore-not-found=true || true

  log "Removing OpenSearch CRDs..."
  run kubectl get crd -o name | grep "opensearch.opster.io" | \
    xargs -r run kubectl delete --ignore-not-found=true || true

  log "Removing cert-manager CRDs..."
  run kubectl get crd -o name | grep "cert-manager.io" | \
    xargs -r run kubectl delete --ignore-not-found=true || true

  log "Removing csi-s3 CRDs..."
  run kubectl get crd -o name | grep "csi.*s3\|s3.*csi" | \
    xargs -r run kubectl delete --ignore-not-found=true || true
else
  log "Skipping CRD removal (use --purge-crds to enable)"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "  ✓ destroy.sh complete — all cluster-wide infrastructure removed"
if [[ "${PURGE_CRDS}" != "true" ]]; then
  echo "  ℹ  CRDs were retained. Run with --purge-crds to remove them."
fi
echo ""
