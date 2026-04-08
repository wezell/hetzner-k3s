#!/usr/bin/env bash
# scripts/install-caddy.sh — Deploy Caddy ingress with Hetzner Cloud LoadBalancer
#
# Caddy is deployed via raw Kubernetes manifests (not a Helm chart) because it
# uses a custom image (mirror.gcr.io/dotcms/caddy-ingress) with the cname_router
# plugin for on-demand TLS tenant validation.
#
# What this script does:
#   1. Validates required env vars (BASE_DOMAIN, ACME_EMAIL)
#   2. Applies Valkey StatefulSet (cert storage for Caddy HA)
#   3. Applies Caddy Deployment + HetznerCloud LoadBalancer Service via envsubst
#   4. Waits for Caddy pods to reach Running state
#   5. Waits for the Hetzner LoadBalancer IP to be assigned
#   6. Prints the LB IP — record this as your wildcard DNS target
#
# Prerequisites:
#   source .env   (provides BASE_DOMAIN, ACME_EMAIL)
#   kubectl context pointed at the k3s cluster
#
# Called by deploy.sh phase_caddy. Idempotent (kubectl apply is additive).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MANIFESTS_DIR="${REPO_ROOT}/manifests"
NAMESPACE="caddy-ingress"
WAIT_TIMEOUT=300  # seconds

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
info() { echo "    $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
highlight() { echo -e "${CYAN}$*${NC}"; }

# ── Validate required environment variables ───────────────────────────────────
validate_env() {
  local missing=()
  [[ -z "${BASE_DOMAIN:-}" ]]          && missing+=("BASE_DOMAIN")
  [[ -z "${ACME_EMAIL:-}" ]]           && missing+=("ACME_EMAIL")
  [[ -z "${CADDY_ADMIN_USER:-}" ]]     && missing+=("CADDY_ADMIN_USER")
  [[ -z "${CADDY_ADMIN_PASSWORD:-}" ]] && missing+=("CADDY_ADMIN_PASSWORD")

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "Missing required env vars: ${missing[*]}"
    err "Source your .env file before running: source .env"
    exit 1
  fi

  info "BASE_DOMAIN          = ${BASE_DOMAIN}"
  info "ACME_EMAIL           = ${ACME_EMAIL}"
  info "CADDY_ADMIN_USER     = ${CADDY_ADMIN_USER}"
  info "CADDY_ADMIN_PASSWORD = (set)"
}

# ── Check if a kubectl resource already exists ────────────────────────────────
resource_exists() {
  local kind="$1" name="$2" ns="$3"
  kubectl get "${kind}" "${name}" -n "${ns}" >/dev/null 2>&1
}

# ── Step 0: Create caddy-admin-auth Secret for BasicAuth (Grafana + Headlamp) ─
# Hashes CADDY_ADMIN_PASSWORD with bcrypt via htpasswd, stores only the hash.
# Idempotent: --dry-run=client | apply skips recreation if hash matches.
create_admin_secret() {
  log "Step 0/5 — Creating caddy-admin-auth Secret (BasicAuth for observe/manage)..."

  # Ensure namespace exists before creating the secret
  kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

  # Require htpasswd (from apache2-utils / httpd-tools)
  if ! command -v htpasswd >/dev/null 2>&1; then
    err "htpasswd not found. Install apache2-utils (Debian/Ubuntu) or httpd-tools (RHEL/Fedora)."
    exit 1
  fi

  local hash
  hash=$(htpasswd -nbB "${CADDY_ADMIN_USER}" "${CADDY_ADMIN_PASSWORD}" | cut -d: -f2)

  kubectl create secret generic caddy-admin-auth \
    --from-literal=user="${CADDY_ADMIN_USER}" \
    --from-literal=hash="${hash}" \
    -n "${NAMESPACE}" \
    --dry-run=client -o yaml | kubectl apply -f -

  info "caddy-admin-auth Secret applied (bcrypt hash, never stores plaintext)"
}

# ── Step 1: Apply Valkey (Redis-compatible) cert storage ──────────────────────
apply_valkey() {
  log "Step 1/5 — Deploying Valkey cert storage (caddy-redis)..."

  kubectl apply -f "${MANIFESTS_DIR}/caddy-redis.yaml"
  info "Valkey StatefulSet and Service applied"

  # Wait for Valkey to be Ready before starting Caddy
  log "Waiting for Valkey to be Ready..."
  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  while [[ $(date +%s) -lt ${deadline} ]]; do
    local ready
    ready=$(kubectl get statefulset caddy-redis -n "${NAMESPACE}" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    if [[ "${ready}" == "1" ]]; then
      info "Valkey ready (1/1)"
      return 0
    fi
    info "Waiting for Valkey... (ready: ${ready:-0}/1)"
    sleep 10
  done

  err "Valkey did not become ready within ${WAIT_TIMEOUT}s"
  kubectl describe statefulset caddy-redis -n "${NAMESPACE}" 2>/dev/null || true
  exit 1
}

# ── Step 2: Apply Caddy manifests with variable substitution ──────────────────
apply_caddy() {
  log "Step 3/5 — Applying Caddy ingress manifests (BASE_DOMAIN=${BASE_DOMAIN})..."

  # envsubst substitutes ${BASE_DOMAIN} and ${ACME_EMAIL} in the Deployment's
  # env: section. The Caddyfile's {$BASE_DOMAIN} syntax is NOT substituted by
  # envsubst (different syntax) — Caddy reads those from the pod's environment.
  export BASE_DOMAIN ACME_EMAIL
  envsubst '${BASE_DOMAIN} ${ACME_EMAIL}' \
    < "${MANIFESTS_DIR}/caddy-ingress.yaml" \
    | kubectl apply -f -

  info "Caddy Namespace, ConfigMap, ServiceAccount, RBAC, Deployment, and Service applied"
}

# ── Step 4: Wait for Caddy pods to reach Running state ───────────────────────
wait_for_caddy_pods() {
  log "Step 4/5 — Waiting for Caddy pods to be Running (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local total not_running
    total=$(kubectl get pods -n "${NAMESPACE}" \
      -l "app=caddy-ingress" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    not_running=$(kubectl get pods -n "${NAMESPACE}" \
      -l "app=caddy-ingress" \
      --field-selector='status.phase!=Running' \
      --no-headers 2>/dev/null | wc -l | tr -d ' ')

    if [[ "${total}" -ge 2 && "${not_running}" -eq 0 ]]; then
      ready=true
      break
    fi

    info "Waiting... Caddy pods Running: $(( total - not_running ))/${total}"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "Caddy pods did not reach Running state within ${WAIT_TIMEOUT}s"
    kubectl get pods -n "${NAMESPACE}" -l "app=caddy-ingress" 2>/dev/null || true
    kubectl describe pods -n "${NAMESPACE}" -l "app=caddy-ingress" 2>/dev/null | tail -30 || true
    exit 1
  fi

  info "All Caddy pods Running"
}

# ── Step 5: Wait for Hetzner LB IP assignment and print it ───────────────────
wait_for_lb_ip() {
  log "Step 5/5 — Waiting for Hetzner Cloud LoadBalancer IP assignment..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local lb_ip=""

  while [[ $(date +%s) -lt ${deadline} ]]; do
    lb_ip=$(kubectl get svc caddy-ingress -n "${NAMESPACE}" \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)

    if [[ -n "${lb_ip}" ]]; then
      break
    fi

    info "Waiting for LB IP assignment (Hetzner provisions within ~30s)..."
    sleep 10
  done

  if [[ -z "${lb_ip}" ]]; then
    err "Hetzner LoadBalancer IP was not assigned within ${WAIT_TIMEOUT}s"
    kubectl describe svc caddy-ingress -n "${NAMESPACE}" 2>/dev/null || true
    exit 1
  fi

  echo ""
  highlight "════════════════════════════════════════════════════"
  highlight "  Caddy LoadBalancer IP: ${lb_ip}"
  highlight "  Wildcard DNS target:   *.${BASE_DOMAIN} → ${lb_ip}"
  highlight ""
  highlight "  Ensure your DNS provider has:"
  highlight "    *.${BASE_DOMAIN}  A  ${lb_ip}"
  highlight "════════════════════════════════════════════════════"
  echo ""

  # Export for callers (e.g. deploy.sh can capture this)
  export CADDY_LB_IP="${lb_ip}"
}

# ── Main ──────────────────────────────────────────────────────────────────────
log "Installing Caddy ingress into namespace '${NAMESPACE}'..."

validate_env
create_admin_secret
apply_valkey
apply_caddy
wait_for_caddy_pods
wait_for_lb_ip

log "Caddy ingress phase complete ✓"
info "Caddy is live at https://*.${BASE_DOMAIN} — on-demand TLS via cname_router"
