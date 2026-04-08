#!/usr/bin/env bash
# configure-dns.sh — Create or update wildcard DNS A record *.BASE_DOMAIN
# pointing to the Caddy ingress LoadBalancer IP via Hetzner DNS API.
#
# Run once after Caddy's LoadBalancer service receives an external IP.
# Idempotent: updates the record if it already exists, creates it otherwise.
#
# Usage:
#   source .env && ./scripts/configure-dns.sh
#   source .env && LB_IP=1.2.3.4 ./scripts/configure-dns.sh   # skip auto-discovery
#
# Required env vars (from .env):
#   HCLOUD_TOKEN  — Hetzner Cloud API token (same token used for compute)
#   BASE_DOMAIN   — apex domain, e.g. botcms.cloud
#   KUBECONFIG    — path to kubeconfig for LB IP discovery
#
# Optional overrides:
#   LB_IP              — skip kubectl discovery and use this IP directly
#   DNS_TTL            — TTL in seconds for the record (default: 300)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../kubeconfig}"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# ── Validate required variables ───────────────────────────────────────────────
REQUIRED_VARS=(HCLOUD_TOKEN BASE_DOMAIN)
missing=()
for var in "${REQUIRED_VARS[@]}"; do
  [[ -z "${!var:-}" ]] && missing+=("$var")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  err "Missing required environment variables (source .env first):"
  for v in "${missing[@]}"; do err "  $v"; done
  exit 1
fi

DNS_TTL="${DNS_TTL:-300}"
HETZNER_DNS_API="https://api.hetzner.cloud/v1/dns"

# ── Step 1: Discover or accept the LoadBalancer IP ────────────────────────────
log "Step 1: Resolving Caddy LoadBalancer IP"

if [[ -n "${LB_IP:-}" ]]; then
  info "Using provided LB_IP=${LB_IP}"
else
  info "Auto-discovering LB IP from caddy/caddy-ingress Service..."

  if [[ ! -f "${KUBECONFIG}" ]]; then
    err "KUBECONFIG not found: ${KUBECONFIG}"
    err "Set LB_IP env var to skip auto-discovery, or ensure KUBECONFIG is valid."
    exit 1
  fi
  export KUBECONFIG

  # Wait up to 3 minutes for the Caddy LoadBalancer to receive an external IP
  local_timeout=180
  local_deadline=$(( $(date +%s) + local_timeout ))
  LB_IP=""

  while [[ $(date +%s) -lt ${local_deadline} ]]; do
    LB_IP=$(kubectl get svc caddy-ingress \
      -n caddy-ingress \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")

    if [[ -n "${LB_IP}" ]]; then
      break
    fi

    info "LoadBalancer IP not yet assigned — retrying in 15s..."
    sleep 15
  done

  if [[ -z "${LB_IP}" ]]; then
    err "Caddy LoadBalancer IP not assigned after ${local_timeout}s"
    err "Check: kubectl get svc caddy-ingress -n caddy-ingress"
    err "Or set LB_IP=<ip> and re-run this script."
    exit 1
  fi
fi

info "LoadBalancer IP: ${LB_IP}"

# ── Step 2: Look up the DNS zone for BASE_DOMAIN ──────────────────────────────
log "Step 2: Looking up Hetzner DNS zone for '${BASE_DOMAIN}'"

zone_response=$(curl -sf \
  -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
  "${HETZNER_DNS_API}/zones?name=${BASE_DOMAIN}" 2>/dev/null)

ZONE_ID=$(echo "${zone_response}" | \
  python3 -c "import sys,json; z=json.load(sys.stdin)['zones']; print(z[0]['id'] if z else '')" \
  2>/dev/null || echo "")

if [[ -z "${ZONE_ID}" ]]; then
  err "DNS zone '${BASE_DOMAIN}' not found in Hetzner DNS."
  err "Create the zone at https://dns.hetzner.com and ensure HCLOUD_TOKEN is correct."
  err "API response: ${zone_response}"
  exit 1
fi

info "Zone ID: ${ZONE_ID}"

# ── Step 3: Check for existing wildcard record ────────────────────────────────
log "Step 3: Checking for existing '*.${BASE_DOMAIN}' A record"

records_response=$(curl -sf \
  -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
  "${HETZNER_DNS_API}/records?zone_id=${ZONE_ID}" 2>/dev/null)

RECORD_ID=$(echo "${records_response}" | \
  python3 -c "
import sys, json
records = json.load(sys.stdin).get('records', [])
match = [r for r in records if r['type'] == 'A' and r['name'] == '*']
print(match[0]['id'] if match else '')
" 2>/dev/null || echo "")

EXISTING_VALUE=$(echo "${records_response}" | \
  python3 -c "
import sys, json
records = json.load(sys.stdin).get('records', [])
match = [r for r in records if r['type'] == 'A' and r['name'] == '*']
print(match[0]['value'] if match else '')
" 2>/dev/null || echo "")

# ── Step 4: Create or update the wildcard A record ───────────────────────────
if [[ -n "${RECORD_ID}" ]]; then
  if [[ "${EXISTING_VALUE}" == "${LB_IP}" ]]; then
    info "Wildcard record *.${BASE_DOMAIN} already points to ${LB_IP} — no change needed"
    log "DNS configuration complete (no-op)"
    exit 0
  fi

  log "Step 4: Updating existing wildcard A record (was: ${EXISTING_VALUE} → ${LB_IP})"

  update_response=$(curl -sf -X PUT \
    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"value\": \"${LB_IP}\",
      \"ttl\": ${DNS_TTL},
      \"type\": \"A\",
      \"name\": \"*\",
      \"zone_id\": \"${ZONE_ID}\"
    }" \
    "${HETZNER_DNS_API}/records/${RECORD_ID}" 2>/dev/null)

  updated_ip=$(echo "${update_response}" | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['record']['value'])" \
    2>/dev/null || echo "")

  if [[ "${updated_ip}" != "${LB_IP}" ]]; then
    err "DNS record update failed or returned unexpected value"
    err "API response: ${update_response}"
    exit 1
  fi

  info "Updated: *.${BASE_DOMAIN} → ${LB_IP} (TTL: ${DNS_TTL}s)"

else
  log "Step 4: Creating wildcard A record *.${BASE_DOMAIN} → ${LB_IP}"

  create_response=$(curl -sf -X POST \
    -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"value\": \"${LB_IP}\",
      \"ttl\": ${DNS_TTL},
      \"type\": \"A\",
      \"name\": \"*\",
      \"zone_id\": \"${ZONE_ID}\"
    }" \
    "${HETZNER_DNS_API}/records" 2>/dev/null)

  created_ip=$(echo "${create_response}" | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['record']['value'])" \
    2>/dev/null || echo "")

  if [[ "${created_ip}" != "${LB_IP}" ]]; then
    err "DNS record creation failed or returned unexpected value"
    err "API response: ${create_response}"
    exit 1
  fi

  info "Created: *.${BASE_DOMAIN} → ${LB_IP} (TTL: ${DNS_TTL}s)"
fi

# ── Step 5: Verify propagation (best-effort) ──────────────────────────────────
log "Step 5: Verifying DNS propagation (best-effort, may lag)"

if command -v dig >/dev/null 2>&1; then
  # Query Hetzner's own nameservers for immediate confirmation
  RESOLVED=$(dig +short "wildcard-check.${BASE_DOMAIN}" @helium.ns.hetzner.de A 2>/dev/null | head -1 || echo "")
  if [[ "${RESOLVED}" == "${LB_IP}" ]]; then
    info "Propagation confirmed via Hetzner nameserver"
  else
    warn "Record not yet visible via Hetzner nameserver (propagation may take 1-2 min)"
    info "Check manually: dig +short '*.${BASE_DOMAIN}' A"
  fi
else
  warn "dig not found — skipping propagation check"
fi

echo ""
echo "======================================================"
echo "Wildcard DNS configured:"
echo "  *.${BASE_DOMAIN}  →  ${LB_IP}  (TTL ${DNS_TTL}s)"
echo ""
echo "All TENANT-ENV.${BASE_DOMAIN} subdomains will resolve"
echo "to the Caddy ingress LoadBalancer without per-tenant"
echo "DNS API calls."
echo "======================================================"
