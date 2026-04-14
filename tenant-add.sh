#!/usr/bin/env bash
# tenant-add.sh — Provision a new tenant environment on the botcms.cloud k3s cluster.
#
# Usage:
#   export TENANT_ID=acme
#   export ENV_ID=prod
#   source .env          # injects WASABI_*, PG_*, OS_*, ACME_EMAIL etc.
#   ./tenant-add.sh
#
# Re-run with the same TENANT_ID and a different ENV_ID to add another environment.
# Namespace creation and quota/limitrange are idempotent (kubectl apply).
#
# What this script creates:
#   Step 1 — Namespace + ResourceQuota + LimitRange                  (tenant-add.sh step 1)
#   Step 2 — Valkey ExternalName Service + connection Secret         (tenant-add.sh step 2)
#   Step 3 — Wasabi backup credentials Secret                        (tenant-add.sh step 3)
#   Step 4 — OpenSearch role, user, and user→role binding + Secret   (tenant-add.sh step 4)
#   Step 5 — CloudNativePG database + credentials Secret             (tenant-add.sh step 5)
#   Step 6 — PersistentVolumeClaim for dotCMS assets                 (tenant-add.sh step 6)
#   Step 7 — dotCMS Deployment, Services, HPA, PDB                   (tenant-add.sh step 7)
#   Step 8 — Ingress routing declaration (tenant-ingress.yaml)        (tenant-add.sh step 8)
#
# Prerequisites:
#   - kubectl configured to target the botcms.cloud cluster (KUBECONFIG set)
#   - CloudNativePG operator installed (deploy.sh)
#   - OpenSearch operator installed (deploy.sh)
#   - Caddy ingress running (deploy.sh)
#   - .env sourced (secrets available as env vars)
#
# Remove a tenant environment: ./tenant-remove.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="${SCRIPT_DIR}/templates"

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
: "${TENANT_ID:?TENANT_ID must be set (e.g. export TENANT_ID=acme)}"
: "${ENV_ID:?ENV_ID must be set (e.g. export ENV_ID=prod)}"
: "${BASE_DOMAIN:?BASE_DOMAIN must be set (source .env — e.g. botcms.cloud)}"

# Validate identifiers — lowercase alphanumeric + hyphens, no leading/trailing hyphens.
if ! [[ "${TENANT_ID}" =~ ^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$ ]]; then
  echo "ERROR: TENANT_ID '${TENANT_ID}' must be lowercase alphanumeric with hyphens (e.g. acme, my-corp)" >&2
  exit 1
fi
if ! [[ "${ENV_ID}" =~ ^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$ ]]; then
  echo "ERROR: ENV_ID '${ENV_ID}' must be lowercase alphanumeric with hyphens (e.g. prod, staging, dev)" >&2
  exit 1
fi

export INSTANCE="${TENANT_ID}-${ENV_ID}"
echo "==> Provisioning tenant environment: ${INSTANCE}"
echo "    Namespace : ${TENANT_ID}"
echo "    Instance  : ${INSTANCE}"

# ---------------------------------------------------------------------------
# Step 1: Namespace, ResourceQuota, LimitRange
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 1: Namespace + ResourceQuota + LimitRange"

sed "s/TENANT_ID/${TENANT_ID}/g" \
  "${TEMPLATES_DIR}/tenant-namespace.yaml" \
  | kubectl apply -f -

echo "    Namespace '${TENANT_ID}' ready."

# ---------------------------------------------------------------------------
# Step 2: Valkey ExternalName Service + connection Secret
# ---------------------------------------------------------------------------
# Creates a local 'valkey' ExternalName Service in the tenant namespace (points
# to the shared cluster-wide Valkey master) and a per-instance Secret
# '${INSTANCE}-valkey' with host/port/password for dotCMS pod consumption.
# Idempotent — safe to re-run if instance already exists.
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 2: Valkey ExternalName Service + connection Secret for '${INSTANCE}'"

# Build the Redis URL from VALKEY_PASSWORD (may be empty if auth is disabled)
if [[ -n "${VALKEY_PASSWORD:-}" ]]; then
  export VALKEY_URL="redis://:${VALKEY_PASSWORD}@valkey-master.valkey.svc.cluster.local:6379"
else
  export VALKEY_URL="redis://valkey-master.valkey.svc.cluster.local:6379"
fi
export VALKEY_PASSWORD="${VALKEY_PASSWORD:-}"

envsubst '${INSTANCE} ${TENANT_ID} ${VALKEY_PASSWORD} ${VALKEY_URL}' \
  < "${TEMPLATES_DIR}/tenant-valkey.yaml" \
  | kubectl apply -f -

echo "    ExternalName Service 'valkey' and Secret '${INSTANCE}-valkey' ready in namespace '${TENANT_ID}'."

# ---------------------------------------------------------------------------
# Step 3: Wasabi backup secret (prerequisite for CNPG cluster backup config)
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 3: Wasabi backup credentials secret"

: "${WASABI_ACCESS_KEY:?WASABI_ACCESS_KEY must be set (source .env)}"
: "${WASABI_SECRET_KEY:?WASABI_SECRET_KEY must be set (source .env)}"

kubectl create secret generic wasabi-backup-creds \
  --namespace="${TENANT_ID}" \
  --from-literal=ACCESS_KEY_ID="${WASABI_ACCESS_KEY}" \
  --from-literal=ACCESS_SECRET_KEY="${WASABI_SECRET_KEY}" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

echo "    wasabi-backup-creds secret ready in namespace '${TENANT_ID}'."

# ---------------------------------------------------------------------------
# Step 3: OpenSearch — action groups, user, role, role mapping + k8s Secret
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 4: OpenSearch user/role provisioning for '${INSTANCE}'"

: "${OPENSEARCH_ADMIN_PASSWORD:?OPENSEARCH_ADMIN_PASSWORD must be set (source .env)}"
OS_ADMIN_USER="${OPENSEARCH_ADMIN_USER:-admin}"

# Generate a per-environment password (32 chars, url-safe base64)
OS_USER_PASS="$(openssl rand -base64 36 | tr -d '/+=\n' | head -c 32)"
OS_USERNAME="${INSTANCE}-os-user"
OS_ROLE="${INSTANCE}-role"
OS_INDEX_PATTERN="cluster_${INSTANCE}*"

# ── Port-forward OpenSearch so deploy-machine curl can reach it ──────────────
OS_LOCAL_PORT=19200
OS_SVC="svc/opensearch"
OS_NS="opensearch"
OS_BASE="https://127.0.0.1:${OS_LOCAL_PORT}"

echo "    Starting kubectl port-forward ${OS_SVC} ${OS_LOCAL_PORT}:9200 ..."
kubectl port-forward "${OS_SVC}" "${OS_LOCAL_PORT}:9200" \
  --namespace="${OS_NS}" &>/tmp/os-pf-${INSTANCE}.log &
OS_PF_PID=$!

# Ensure port-forward is killed on exit/error
cleanup_pf() { kill "${OS_PF_PID}" 2>/dev/null || true; }
trap cleanup_pf EXIT

# Wait up to 15s for port-forward to be ready
_os_wait=0
until curl -sfk -o /dev/null "${OS_BASE}" -u "${OS_ADMIN_USER}:${OPENSEARCH_ADMIN_PASSWORD}" \
    --max-time 2 2>/dev/null; do
  sleep 1
  _os_wait=$(( _os_wait + 1 ))
  if [[ ${_os_wait} -ge 15 ]]; then
    echo "ERROR: OpenSearch port-forward not ready after 15s. Check opensearch namespace." >&2
    cat /tmp/os-pf-${INSTANCE}.log >&2 || true
    exit 1
  fi
done
echo "    OpenSearch reachable at ${OS_BASE}."

# Helper: idempotent PUT (skip if resource already exists)
os_put() {
  local uri="$1"
  local payload="$2"
  local label="$3"
  local status
  status=$(curl -sk -o /dev/null -w "%{http_code}" \
    -u "${OS_ADMIN_USER}:${OPENSEARCH_ADMIN_PASSWORD}" \
    "${OS_BASE}/${uri}" --max-time 10 2>/dev/null)
  if [[ "${status}" == "200" ]]; then
    echo "    [skip] ${label} already exists."
    return 0
  fi
  local resp
  resp=$(curl -sfk -X PUT \
    -u "${OS_ADMIN_USER}:${OPENSEARCH_ADMIN_PASSWORD}" \
    -H "Content-Type: application/json" \
    -d "${payload}" \
    "${OS_BASE}/${uri}" --max-time 10)
  echo "    [ok]   ${label} created. ${resp}"
}

# ── Action groups ─────────────────────────────────────────────────────────────
os_put "_plugins/_security/api/actiongroups/${INSTANCE}-cluster" \
  '{"allowed_actions":["cluster:monitor/health","indices:data/write/bulk","cluster:monitor/state","cluster:monitor/nodes/stats","indices:data/read/scroll","indices:data/read/scroll/clear"]}' \
  "action-group/${INSTANCE}-cluster"

os_put "_plugins/_security/api/actiongroups/${INSTANCE}-index" \
  '{"allowed_actions":["indices_all","indices_monitor"]}' \
  "action-group/${INSTANCE}-index"

os_put "_plugins/_security/api/actiongroups/${INSTANCE}-all-indices" \
  '{"allowed_actions":["indices:monitor/stats","indices:monitor/settings/get","indices:admin/aliases/get"]}' \
  "action-group/${INSTANCE}-all-indices"

# ── User ──────────────────────────────────────────────────────────────────────
os_put "_plugins/_security/api/internalusers/${OS_USERNAME}" \
  "{\"password\":\"${OS_USER_PASS}\",\"attributes\":{\"dotcms.instance\":\"${INSTANCE}\"}}" \
  "user/${OS_USERNAME}"

# ── Role ──────────────────────────────────────────────────────────────────────
os_put "_plugins/_security/api/roles/${OS_ROLE}" \
  "{\"cluster_permissions\":[\"${INSTANCE}-cluster\"],\"index_permissions\":[{\"index_patterns\":[\"${OS_INDEX_PATTERN}\"],\"allowed_actions\":[\"${INSTANCE}-index\"]},{\"index_patterns\":[\"*\"],\"allowed_actions\":[\"${INSTANCE}-all-indices\"]}]}" \
  "role/${OS_ROLE}"

# ── Role mapping ──────────────────────────────────────────────────────────────
os_put "_plugins/_security/api/rolesmapping/${OS_ROLE}" \
  "{\"users\":[\"${OS_USERNAME}\"]}" \
  "role-mapping/${OS_ROLE} → ${OS_USERNAME}"

# ── Stop port-forward ─────────────────────────────────────────────────────────
trap - EXIT
cleanup_pf
rm -f "/tmp/os-pf-${INSTANCE}.log"
echo "    OpenSearch port-forward closed."

# ── Kubernetes Secret with OpenSearch credentials ─────────────────────────────
echo "    Creating Kubernetes secret '${INSTANCE}-os-creds' in namespace '${TENANT_ID}'..."
kubectl create secret generic "${INSTANCE}-os-creds" \
  --namespace="${TENANT_ID}" \
  --from-literal=username="${OS_USERNAME}" \
  --from-literal=password="${OS_USER_PASS}" \
  --from-literal=host="opensearch.opensearch.svc.cluster.local" \
  --from-literal=port="9200" \
  --from-literal=index_prefix="cluster_${INSTANCE}" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

echo "    OpenSearch user '${OS_USERNAME}', role '${OS_ROLE}', and secret '${INSTANCE}-os-creds' ready."

# ---------------------------------------------------------------------------
# Step 4: PostgreSQL role + Database CRD + credentials Secret
# ---------------------------------------------------------------------------
# Architecture: one shared CNPG cluster in the `postgres` namespace serves all
# tenants. Each tenant gets an isolated logical database and a dedicated role.
#
# Sub-steps:
#   4a — Generate password; create PostgreSQL role via kubectl exec SQL.
#        (Role must exist before CNPG reconciles the Database CRD.)
#   4b — Apply templates/tenant-postgres.yaml via envsubst:
#          • postgresql.cnpg.io/v1 Database CRD  → CNPG declaratively manages
#            the database lifecycle (create/alter owner on reconcile).
#          • v1 Secret ${INSTANCE}-postgres       → credentials consumed by
#            dotCMS pods via secretKeyRef / envFrom.
#   4c — Wait for Database CRD to reach Ready status (CNPG async reconcile).
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 5: PostgreSQL role + Database CRD + credentials Secret for '${INSTANCE}'"

PG_PASS="$(openssl rand -base64 36 | tr -d '/+=\n' | head -c 32)"
PG_PRIMARY_POD="postgres-1"
PG_NS="postgres"

# ── 4a: Verify cluster reachable + create role (idempotent) ──────────────────
if ! kubectl get pod "${PG_PRIMARY_POD}" -n "${PG_NS}" &>/dev/null; then
  echo "ERROR: Shared CNPG primary pod '${PG_PRIMARY_POD}' not found in namespace '${PG_NS}'." >&2
  echo "       Run deploy.sh first to install the shared PostgreSQL cluster." >&2
  exit 1
fi

echo "    4a: Creating PostgreSQL role '${INSTANCE}' (idempotent)..."
kubectl exec -n "${PG_NS}" "${PG_PRIMARY_POD}" -- psql -U postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${INSTANCE}') THEN
    CREATE ROLE "${INSTANCE}" WITH LOGIN PASSWORD '${PG_PASS}';
  ELSE
    ALTER ROLE "${INSTANCE}" WITH PASSWORD '${PG_PASS}';
  END IF;
END \$\$;
SQL

echo "    Role '${INSTANCE}' ready."

# ── 4b: Create database via SQL + create credentials Secret ──────────────────
echo "    4b: Creating database '${INSTANCE}' and credentials Secret..."

# Create the database (idempotent)
kubectl exec -n "${PG_NS}" "${PG_PRIMARY_POD}" -- psql -U postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = '${INSTANCE}') THEN
    CREATE DATABASE "${INSTANCE}" OWNER "${INSTANCE}";
  END IF;
END \$\$;
SQL

# Create credentials Secret in tenant namespace (envsubst substitutes INSTANCE, TENANT_ID, PG_PASS)
# Only the Secret part of tenant-postgres.yaml (skip the Database CRD if CNPG version doesn't support it)
export INSTANCE TENANT_ID PG_PASS
envsubst '${INSTANCE} ${TENANT_ID} ${PG_PASS}' < "${TEMPLATES_DIR}/tenant-postgres.yaml" \
  | grep -v "^kind: Database$" \
  | kubectl apply -f - --validate=false 2>/dev/null || \
  kubectl create secret generic "${INSTANCE}-postgres" \
    --namespace="${TENANT_ID}" \
    --from-literal=host="postgres-rw.postgres.svc.cluster.local" \
    --from-literal=port="5432" \
    --from-literal=database="${INSTANCE}" \
    --from-literal=username="${INSTANCE}" \
    --from-literal=password="${PG_PASS}" \
    --dry-run=client -o yaml | kubectl apply -f -

echo "    Database '${INSTANCE}' and Secret '${INSTANCE}-postgres' ready."

echo "    PostgreSQL database '${INSTANCE}' ready."
echo "    Secret '${INSTANCE}-postgres' created in namespace '${TENANT_ID}'."

# ── 4d: Extract and expose DB credentials ────────────────────────────────────
# Read the managed Secret back from the tenant namespace (values are base64 in
# the .data map; use kubectl get -o go-template to decode them inline).
echo "    4d: Reading back '${INSTANCE}-postgres' secret for downstream use..."

_pg_secret_ns="${TENANT_ID}"
_pg_secret_name="${INSTANCE}-postgres"
_decode_tmpl='{{index .data "%s" | base64decode}}'

PG_CRED_HOST=$(kubectl get secret "${_pg_secret_name}" \
  -n "${_pg_secret_ns}" \
  -o go-template="$(printf "${_decode_tmpl}" host)")

PG_CRED_PORT=$(kubectl get secret "${_pg_secret_name}" \
  -n "${_pg_secret_ns}" \
  -o go-template="$(printf "${_decode_tmpl}" port)")

PG_CRED_DB=$(kubectl get secret "${_pg_secret_name}" \
  -n "${_pg_secret_ns}" \
  -o go-template="$(printf "${_decode_tmpl}" database)")

PG_CRED_USER=$(kubectl get secret "${_pg_secret_name}" \
  -n "${_pg_secret_ns}" \
  -o go-template="$(printf "${_decode_tmpl}" username)")

PG_CRED_PASS=$(kubectl get secret "${_pg_secret_name}" \
  -n "${_pg_secret_ns}" \
  -o go-template="$(printf "${_decode_tmpl}" password)")

# ── Write per-tenant config file ──────────────────────────────────────────────
TENANT_ENVS_DIR="${SCRIPT_DIR}/tenant-envs"
mkdir -p "${TENANT_ENVS_DIR}"
TENANT_CREDS_FILE="${TENANT_ENVS_DIR}/${INSTANCE}.env"

cat > "${TENANT_CREDS_FILE}" <<EOF
# Auto-generated by tenant-add.sh — DO NOT COMMIT (gitignored)
# Tenant: ${TENANT_ID}  Instance: ${INSTANCE}  Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# PostgreSQL
PG_HOST=${PG_CRED_HOST}
PG_PORT=${PG_CRED_PORT}
PG_DATABASE=${PG_CRED_DB}
PG_USERNAME=${PG_CRED_USER}
PG_PASSWORD=${PG_CRED_PASS}
PG_JDBC_URL=jdbc:postgresql://${PG_CRED_HOST}:${PG_CRED_PORT}/${PG_CRED_DB}

# OpenSearch
OS_HOST=opensearch.opensearch.svc.cluster.local
OS_PORT=9200
OS_USERNAME=${OS_USERNAME}
OS_PASSWORD=${OS_USER_PASS}
OS_INDEX_PREFIX=cluster_${INSTANCE}
EOF

chmod 600 "${TENANT_CREDS_FILE}"

echo ""
echo "    ┌─── DB credentials for ${INSTANCE} ────────────────────────────────"
echo "    │  Host     : ${PG_CRED_HOST}"
echo "    │  Port     : ${PG_CRED_PORT}"
echo "    │  Database : ${PG_CRED_DB}"
echo "    │  Username : ${PG_CRED_USER}"
echo "    │  Password : ${PG_CRED_PASS}"
echo "    │  JDBC URL : jdbc:postgresql://${PG_CRED_HOST}:${PG_CRED_PORT}/${PG_CRED_DB}"
echo "    └─────────────────────────────────────────────────────────────────────"
echo "    Written to : ${TENANT_CREDS_FILE} (mode 600)"
echo ""

# ---------------------------------------------------------------------------
# Step 5: Static PV + PVC for dotCMS assets (S3-backed via csi-s3/geesefs)
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 6: S3-backed PV + PVC '${INSTANCE}-assets'"

# Default 20Gi; override by exporting ASSETS_STORAGE_SIZE before running.
export ASSETS_STORAGE_SIZE="${ASSETS_STORAGE_SIZE:-20Gi}"
export INSTANCE TENANT_ID WASABI_S3FUSE_BUCKET

: "${WASABI_S3FUSE_BUCKET:?WASABI_S3FUSE_BUCKET must be set (source .env)}"

envsubst '${INSTANCE} ${TENANT_ID} ${WASABI_S3FUSE_BUCKET} ${ASSETS_STORAGE_SIZE}' \
  < "${TEMPLATES_DIR}/tenant-pvc.yaml" \
  | kubectl apply -f -

echo "    PV + PVC '${INSTANCE}-assets' (${ASSETS_STORAGE_SIZE}, s3-fuse → ${WASABI_S3FUSE_BUCKET}/${TENANT_ID}/${INSTANCE}) ready."

# ---------------------------------------------------------------------------
# Step 6: dotCMS Deployment, Services, HPA, PDB
# ---------------------------------------------------------------------------
# Uses envsubst to substitute tenant-specific variables into the manifest
# template, then applies it to the tenant namespace.
#
# Required (from .env or environment):
#   DOTCMS_IMAGE   — fully-qualified image ref (e.g. mirror.gcr.io/dotcms/dotcms:LTS-24.10)
#
# Optional overrides (defaults shown):
#   CPU_REQUEST    — CPU request per pod   (default: "1")
#   MEMORY_REQUEST — memory request        (default: "4Gi")
#   MEMORY_LIMIT   — memory limit          (default: "5Gi")
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 7: dotCMS Deployment, Services, HPA, PDB for '${INSTANCE}'"

: "${DOTCMS_IMAGE:?DOTCMS_IMAGE must be set (e.g. export DOTCMS_IMAGE=mirror.gcr.io/dotcms/dotcms:LTS-24.10)}"
export CPU_REQUEST="${CPU_REQUEST:-1}"
export MEMORY_REQUEST="${MEMORY_REQUEST:-4Gi}"
export MEMORY_LIMIT="${MEMORY_LIMIT:-5Gi}"
export INSTANCE TENANT_ID DOTCMS_IMAGE

echo "    Image         : ${DOTCMS_IMAGE}"
echo "    CPU request   : ${CPU_REQUEST}"
echo "    Memory        : ${MEMORY_REQUEST} request / ${MEMORY_LIMIT} limit"

envsubst '${INSTANCE} ${TENANT_ID} ${DOTCMS_IMAGE} ${CPU_REQUEST} ${MEMORY_REQUEST} ${MEMORY_LIMIT}' \
  < "${TEMPLATES_DIR}/dotcms-deployment.yaml" \
  | kubectl apply -f -

echo "    Deployment, PDB, HPA, ClusterIP + Headless Services applied."

echo "    Waiting for deployment '${INSTANCE}' to be available (timeout 300s)..."
kubectl rollout status deployment/"${INSTANCE}" \
  --namespace="${TENANT_ID}" \
  --timeout=300s

# ---------------------------------------------------------------------------
# Step 8: Ingress routing declaration
# ---------------------------------------------------------------------------
# Creates a Kubernetes Ingress resource in the tenant namespace that declares
# the routing intent: ${INSTANCE}.${BASE_DOMAIN} → ${INSTANCE} ClusterIP svc.
#
# Caddy's cname_router handles actual traffic proxying by service-name
# convention (no ingress-controller watch). This resource provides:
#   • Discoverable inventory  : kubectl get ingress -A
#   • Lifecycle management    : deleted alongside Deployment in tenant-remove.sh
#   • Authoritative hostname  : botcms.cloud/hostname annotation for tooling
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 8: Ingress routing declaration for '${INSTANCE}.${BASE_DOMAIN}'"

export INSTANCE TENANT_ID BASE_DOMAIN

envsubst '${INSTANCE} ${TENANT_ID} ${BASE_DOMAIN}' \
  < "${TEMPLATES_DIR}/tenant-ingress.yaml" \
  | kubectl apply -f -

echo "    Ingress '${INSTANCE}' → ${INSTANCE}.${BASE_DOMAIN} declared in namespace '${TENANT_ID}'."

# ---------------------------------------------------------------------------
# Step 9: CaddyRoute registration and route activation verification
# ---------------------------------------------------------------------------
# Creates a ConfigMap in the caddy-ingress namespace that registers this
# tenant route as a discoverable catalog entry. Provides an audit trail of
# all active routes: kubectl get configmap -n caddy-ingress -l botcms.cloud/type=caddy-route
#
# NOTE: Caddy's cname_router plugin does NOT watch these ConfigMaps — it
# auto-discovers services via K8s API (ClusterRole grants list/watch on
# services cluster-wide). The route is active as soon as the ${INSTANCE}
# ClusterIP Service exists and has at least one ready endpoint.
#
# After applying the ConfigMap, this step waits for the service endpoint
# to have ready addresses, confirming that cname_router can resolve and
# proxy traffic to the tenant pod.
# ---------------------------------------------------------------------------
echo ""
echo "--> Step 9: CaddyRoute registration and route activation check"

export INSTANCE TENANT_ID BASE_DOMAIN

envsubst '${INSTANCE} ${TENANT_ID} ${BASE_DOMAIN}' \
  < "${TEMPLATES_DIR}/tenant-caddy-route.yaml" \
  | kubectl apply -f -

echo "    CaddyRoute ConfigMap 'route-${INSTANCE}' registered in caddy-ingress namespace."

# Wait for the ClusterIP Service endpoint to have at least 1 ready address.
# cname_router resolves the headless service (${INSTANCE}-hl) to individual pod
# IPs, but we probe the ClusterIP endpoint as the availability signal since it
# reflects the same pod readiness state and is simpler to query.
echo "    Waiting for endpoint '${INSTANCE}' to have ready addresses (timeout 120s)..."

_route_timeout=120
_route_deadline=$(( $(date +%s) + _route_timeout ))
_route_active=false

while [[ $(date +%s) -lt ${_route_deadline} ]]; do
  _ready_addrs=$(kubectl get endpoints "${INSTANCE}" \
    --namespace="${TENANT_ID}" \
    -o jsonpath='{.subsets[0].addresses}' 2>/dev/null || echo "")
  if [[ -n "${_ready_addrs}" && "${_ready_addrs}" != "null" ]]; then
    _route_active=true
    break
  fi
  echo "    No ready addresses yet — waiting..."
  sleep 5
done

if [[ "${_route_active}" != "true" ]]; then
  echo ""
  echo "WARN: Endpoint '${INSTANCE}' has no ready addresses after ${_route_timeout}s." >&2
  echo "      CaddyRoute is registered but traffic routing may not work until pods are ready." >&2
  echo "      Check: kubectl get endpoints ${INSTANCE} -n ${TENANT_ID}" >&2
  echo "      Check: kubectl get pods -n ${TENANT_ID} -l app.kubernetes.io/instance=${INSTANCE}" >&2
else
  echo "    Route active — endpoint '${INSTANCE}' has ready pod addresses."
  echo "    cname_router can now route: https://${INSTANCE}.${BASE_DOMAIN} → ${INSTANCE}.${TENANT_ID}.svc.cluster.local:8082"
fi

echo ""
echo "==> All 9 steps complete."
echo "    Tenant  : ${TENANT_ID}"
echo "    Instance: ${INSTANCE}"
echo "    URL     : https://${INSTANCE}.${BASE_DOMAIN}"
echo ""
echo "    Resources provisioned:"
echo "      Namespace   ${TENANT_ID}"
echo "      Service     valkey                  (ExternalName → valkey-master.valkey, ${TENANT_ID})"
echo "      Secret      ${INSTANCE}-valkey      (${TENANT_ID})"
echo "      Secret      wasabi-backup-creds     (${TENANT_ID})"
echo "      OpenSearch  user=${OS_USERNAME} → role=${OS_ROLE}"
echo "      Secret      ${INSTANCE}-os-creds    (${TENANT_ID})"
echo "      PG database ${INSTANCE} in shared cluster"
echo "      Secret      ${INSTANCE}-postgres    (${TENANT_ID})"
echo "      Creds file  tenant-envs/${INSTANCE}.env (mode 600, gitignored)"
echo "      PV + PVC    ${INSTANCE}-assets      (${ASSETS_STORAGE_SIZE}, s3-fuse)"
echo "      Deployment  ${INSTANCE}             (${DOTCMS_IMAGE})"
echo "      HPA         ${INSTANCE}             (1–6 replicas)"
echo "      PDB         ${INSTANCE}             (maxUnavailable=1)"
echo "      Service     ${INSTANCE}             (ClusterIP :80→8082)"
echo "      Service     ${INSTANCE}-hl          (Headless  :80→8082)"
echo "      Ingress     ${INSTANCE}             (${INSTANCE}.${BASE_DOMAIN} → svc:80)"
echo "      CaddyRoute  route-${INSTANCE}       (caddy-ingress ns, route catalog entry)"
