#!/usr/bin/env bash
# tenant-remove.sh — Remove a tenant namespace and all its resources from the botcms.cloud k3s cluster.
#
# Usage (env vars):
#   export TENANT_ID=acme
#   source .env
#   ./tenant-remove.sh [--yes] [--dry-run]
#
# Usage (positional args — compatible with destroy.sh --force-tenants):
#   ./tenant-remove.sh <TENANT_ID> [ENV_ID] [--yes] [--dry-run]
#
# What this script removes:
#   - Tenant namespace and ALL namespace-scoped resources (cascading delete):
#       Deployments, ReplicaSets, Pods, Services, Ingresses
#       PersistentVolumeClaims, Secrets, ConfigMaps
#       CloudNativePG Cluster and ScheduledBackup CRs
#       HPAs, PodDisruptionBudgets
#   - NOTE: ENV_ID is accepted for logging/validation but the entire tenant namespace
#     is removed. To remove a single environment, pass --env-only (Step 6 additions only).
#
# Flags:
#   --yes         Skip interactive confirmation prompt
#   --dry-run     Print actions without executing them
#   --env-only    Remove only ENV_ID-specific resources (keeps namespace + other envs)
#
# Prerequisites:
#   - kubectl configured to target the botcms.cloud cluster (KUBECONFIG set)
#   - TENANT_ID set (env var or first positional arg)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Argument parsing ─────────────────────────────────────────────────────────
YES=false
DRY_RUN=false
ENV_ONLY=false
POSITIONAL=()

for arg in "$@"; do
  case "${arg}" in
    --yes|-y)        YES=true ;;
    --dry-run)       DRY_RUN=true ;;
    --env-only)      ENV_ONLY=true ;;
    --*)             echo "Unknown flag: ${arg}" >&2; exit 1 ;;
    *)               POSITIONAL+=("${arg}") ;;
  esac
done

# Positional args override env vars
if [[ ${#POSITIONAL[@]} -ge 1 ]]; then
  TENANT_ID="${POSITIONAL[0]}"
fi
if [[ ${#POSITIONAL[@]} -ge 2 ]]; then
  ENV_ID="${POSITIONAL[1]}"
fi

# ─── Validation ───────────────────────────────────────────────────────────────
: "${TENANT_ID:?TENANT_ID must be set (env var or first positional arg, e.g. acme)}"

if ! [[ "${TENANT_ID}" =~ ^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$ ]]; then
  echo "ERROR: TENANT_ID '${TENANT_ID}' must be lowercase alphanumeric with hyphens." >&2
  exit 1
fi

ENV_ID="${ENV_ID:-}"
if [[ -n "${ENV_ID}" ]] && ! [[ "${ENV_ID}" =~ ^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$ ]]; then
  echo "ERROR: ENV_ID '${ENV_ID}' must be lowercase alphanumeric with hyphens." >&2
  exit 1
fi

INSTANCE="${TENANT_ID}${ENV_ID:+-${ENV_ID}}"

export KUBECONFIG="${KUBECONFIG:-${HOME}/.kube/config}"

# ─── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo "  [tenant-remove] $*"; }
warn() { echo "  [tenant-remove] WARNING: $*" >&2; }

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

kubectl_delete() {
  run kubectl delete --ignore-not-found=true "$@"
}

ns_exists() {
  kubectl get namespace "$1" &>/dev/null
}

# ─── Pre-flight ───────────────────────────────────────────────────────────────
log "Pre-flight: verifying cluster connectivity"
if ! kubectl cluster-info &>/dev/null; then
  echo "ERROR: Cannot connect to cluster. Check KUBECONFIG." >&2
  exit 1
fi

echo ""
echo "==> tenant-remove.sh — removing tenant: ${TENANT_ID}"
[[ -n "${ENV_ID}" ]] && echo "    Instance  : ${INSTANCE}"
echo "    Namespace : ${TENANT_ID}"
[[ "${ENV_ONLY}" == "true" ]] && echo "    Mode      : env-only (namespace retained)"
[[ "${DRY_RUN}" == "true" ]]  && echo "    Mode      : DRY RUN — no changes will be made"
echo ""

# ─── Confirm ──────────────────────────────────────────────────────────────────
if [[ "${YES}" == "false" && "${DRY_RUN}" == "false" ]]; then
  if [[ "${ENV_ONLY}" == "true" && -n "${ENV_ID}" ]]; then
    read -r -p "  Delete environment '${INSTANCE}' resources from namespace '${TENANT_ID}'? [y/N] " confirm
  else
    read -r -p "  Delete namespace '${TENANT_ID}' and ALL its resources? [y/N] " confirm
  fi
  if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
    echo "  Aborted."
    exit 0
  fi
fi

# ─── Namespace existence check ────────────────────────────────────────────────
if ! ns_exists "${TENANT_ID}"; then
  warn "Namespace '${TENANT_ID}' does not exist — nothing to remove."
  exit 0
fi

# ─── Helper: deprovision a single instance from shared clusters ───────────────
# Drops Postgres DB+role and deletes OpenSearch user/role/mapping for INSTANCE.
deprovision_instance() {
  local instance="$1"

  # ── Postgres: delete CNPG Database CR, then drop database + role in shared cluster ─
  log "Removing CNPG Database CR: ${instance}"
  # Delete the declarative Database CR first so CNPG stops reconciling it.
  # Must precede the SQL DROP to prevent CNPG from recreating the database.
  run kubectl delete database "${instance}" \
    --namespace=postgres \
    --ignore-not-found=true \
    --timeout=60s 2>/dev/null || \
    warn "CNPG Database CR '${instance}' deletion timed out — check CNPG operator"

  log "Dropping Postgres database and role: ${instance}"
  if kubectl get pod postgres-1 -n postgres &>/dev/null; then
    run kubectl exec -n postgres postgres-1 -- psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${instance}' AND pid <> pg_backend_pid();" 2>/dev/null || true
    run kubectl exec -n postgres postgres-1 -- psql -U postgres -c "DROP DATABASE IF EXISTS \"${instance}\";" 2>/dev/null || \
      warn "DROP DATABASE ${instance} failed — may already be gone"
    run kubectl exec -n postgres postgres-1 -- psql -U postgres -c "DROP ROLE IF EXISTS \"${instance}\";" 2>/dev/null || \
      warn "DROP ROLE ${instance} failed — may already be gone"
  else
    warn "Shared CNPG primary pod 'postgres-1' not found — skipping Postgres SQL cleanup for ${instance}"
  fi

  # ── OpenSearch: delete user / role / role-mapping via Security API ──────────
  log "Removing OpenSearch user/role for: ${instance}"
  local os_user="${instance}-os-user"
  local os_role="${instance}-role"
  local os_local_port=19201
  : "${OPENSEARCH_ADMIN_PASSWORD:=${OPENSEARCH_ADMIN_PASSWORD:-}}"
  : "${OPENSEARCH_ADMIN_USER:=${OPENSEARCH_ADMIN_USER:-admin}}"

  if [[ -n "${OPENSEARCH_ADMIN_PASSWORD}" ]]; then
    kubectl port-forward svc/opensearch "${os_local_port}:9200" \
      --namespace=opensearch &>/tmp/os-pf-remove-${instance}.log &
    local os_pf_pid=$!
    trap "kill ${os_pf_pid} 2>/dev/null || true; rm -f /tmp/os-pf-remove-${instance}.log" RETURN

    local _w=0
    until curl -sfk -o /dev/null "https://127.0.0.1:${os_local_port}" \
        -u "${OPENSEARCH_ADMIN_USER}:${OPENSEARCH_ADMIN_PASSWORD}" --max-time 2 2>/dev/null; do
      sleep 1; _w=$((_w+1))
      [[ ${_w} -ge 10 ]] && { warn "OpenSearch not reachable — skipping OS cleanup for ${instance}"; break; }
    done

    for resource in \
      "_plugins/_security/api/rolesmapping/${os_role}" \
      "_plugins/_security/api/roles/${os_role}" \
      "_plugins/_security/api/internalusers/${os_user}" \
      "_plugins/_security/api/actiongroups/${instance}-cluster" \
      "_plugins/_security/api/actiongroups/${instance}-index" \
      "_plugins/_security/api/actiongroups/${instance}-all-indices"; do
      run curl -sfk -X DELETE \
        -u "${OPENSEARCH_ADMIN_USER}:${OPENSEARCH_ADMIN_PASSWORD}" \
        "https://127.0.0.1:${os_local_port}/${resource}" \
        --max-time 10 2>/dev/null || true
    done

    kill "${os_pf_pid}" 2>/dev/null || true
    rm -f "/tmp/os-pf-remove-${instance}.log"
  else
    warn "OPENSEARCH_ADMIN_PASSWORD not set — skipping OpenSearch cleanup for ${instance}"
  fi
}

# ─── ENV_ONLY mode: remove only the specific environment's resources ──────────
# Used when a tenant has multiple environments sharing one namespace.
if [[ "${ENV_ONLY}" == "true" && -n "${ENV_ID}" ]]; then
  echo "--> Removing env-specific resources for: ${INSTANCE}"

  # Remove from shared clusters (Postgres DB + OpenSearch user/role)
  deprovision_instance "${INSTANCE}"

  # Delete env-specific k8s resources
  for resource in deployment service hpa poddisruptionbudget; do
    log "Removing ${resource}/${INSTANCE}"
    kubectl_delete "${resource}" "${INSTANCE}" -n "${TENANT_ID}" 2>/dev/null || true
    kubectl_delete "${resource}" "${INSTANCE}-hl" -n "${TENANT_ID}" 2>/dev/null || true
  done

  log "Removing secrets for: ${INSTANCE}"
  kubectl_delete secret "${INSTANCE}-valkey"   -n "${TENANT_ID}" 2>/dev/null || true
  kubectl_delete secret "${INSTANCE}-postgres" -n "${TENANT_ID}" 2>/dev/null || true
  kubectl_delete secret "${INSTANCE}-os-creds" -n "${TENANT_ID}" 2>/dev/null || true

  log "Removing PVC: ${INSTANCE}-assets"
  kubectl_delete pvc "${INSTANCE}-assets" -n "${TENANT_ID}" 2>/dev/null || true

  # Static PVs are cluster-scoped — not deleted by namespace removal
  log "Removing static PV: ${INSTANCE}-assets"
  kubectl_delete pv "${INSTANCE}-assets" 2>/dev/null || true

  log "Removing Ingress routing declaration: ${INSTANCE}"
  kubectl_delete ingress "${INSTANCE}" -n "${TENANT_ID}" 2>/dev/null || true

  log "Removing CaddyRoute catalog entry: route-${INSTANCE}"
  kubectl_delete configmap "route-${INSTANCE}" -n caddy-ingress 2>/dev/null || true

  echo ""
  echo "==> Environment '${INSTANCE}' removed. Namespace '${TENANT_ID}' retained."
  echo ""
  exit 0
fi

# ─── Full namespace removal ───────────────────────────────────────────────────
echo "--> Removing all resources in namespace: ${TENANT_ID}"

# Discover all tenant instances in this namespace by listing *-postgres secrets.
# Each instance (TENANT_ID-ENV_ID) has a secret named "${INSTANCE}-postgres".
log "Discovering environments in namespace '${TENANT_ID}'..."
INSTANCES=$(kubectl get secrets -n "${TENANT_ID}" \
  -o jsonpath='{.items[*].metadata.name}' 2>/dev/null \
  | tr ' ' '\n' \
  | grep -E '^.+-postgres$' \
  | sed 's/-postgres$//' || true)

if [[ -n "${INSTANCES}" ]]; then
  log "Found environments: $(echo "${INSTANCES}" | tr '\n' ' ')"
  for inst in ${INSTANCES}; do
    deprovision_instance "${inst}"
  done
else
  log "No environments found — skipping Postgres/OpenSearch cleanup"
fi

# Delete static PVs (cluster-scoped — not removed by namespace deletion)
log "Removing static PVs for tenant: ${TENANT_ID}"
for inst in ${INSTANCES:-}; do
  kubectl_delete pv "${inst}-assets" 2>/dev/null || true
done

# Remove CaddyRoute catalog entries from caddy-ingress namespace (cluster-scoped,
# not removed by tenant namespace deletion — must be cleaned up explicitly).
log "Removing CaddyRoute catalog entries for tenant: ${TENANT_ID}"
for inst in ${INSTANCES:-}; do
  kubectl_delete configmap "route-${inst}" -n caddy-ingress 2>/dev/null || true
done

# Scale down Deployments to stop active workloads before namespace deletion
log "Scaling down Deployments in namespace: ${TENANT_ID}"
kubectl_delete deployment --all -n "${TENANT_ID}" 2>/dev/null || true

# Delete the tenant namespace — Kubernetes cascades deletion to all
# namespace-scoped resources: Pods, Services, PVCs, Secrets, ConfigMaps,
# Ingresses, HPAs, PodDisruptionBudgets, RBAC, etc.
log "Deleting namespace: ${TENANT_ID}"
if [[ "${DRY_RUN}" == "true" ]]; then
  echo "  [dry-run] kubectl delete namespace ${TENANT_ID} --timeout=120s"
else
  kubectl delete namespace "${TENANT_ID}" --timeout=120s || \
    warn "Namespace deletion timed out — it may still be terminating (finalizers pending)"
fi

echo ""
echo "==> Tenant '${TENANT_ID}' removed. Namespace and all resources deleted."
echo ""
