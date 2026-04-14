#!/usr/bin/env bash
# configure-dns.sh — Create or update wildcard DNS A record *.BASE_DOMAIN
# pointing to the Caddy ingress LoadBalancer IP via hcloud CLI.
#
# Uses: hcloud zone rrset (api.hetzner.com/v1 with HCLOUD_TOKEN)
# Do NOT use dns.hetzner.com or HETZNER_DNS_TOKEN — they do not work.
#
# Run once after Caddy's LoadBalancer service receives an external IP.
# Idempotent: updates the record if it already exists, creates it otherwise.
#
# Usage:
#   source .env && ./scripts/configure-dns.sh
#   source .env && LB_IP=1.2.3.4 ./scripts/configure-dns.sh
#
# Required env vars (from .env):
#   HCLOUD_TOKEN  — Hetzner Cloud API token
#   BASE_DOMAIN   — apex domain, e.g. botcms.cloud
#   KUBECONFIG    — path to kubeconfig for LB IP discovery

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUBECONFIG="${KUBECONFIG:-${SCRIPT_DIR}/../kubeconfig}"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

for var in HCLOUD_TOKEN BASE_DOMAIN; do
  [[ -z "${!var:-}" ]] && { err "Missing required env var: $var (source .env first)"; exit 1; }
done

DNS_TTL="${DNS_TTL:-60}"

# ── Step 1: Discover or accept the LoadBalancer IP ────────────────────────────
log "Step 1: Resolving Caddy LoadBalancer IP"

if [[ -n "${LB_IP:-}" ]]; then
  info "Using provided LB_IP=${LB_IP}"
else
  info "Auto-discovering LB IP from caddy-ingress Service..."
  export KUBECONFIG
  local_timeout=180
  local_deadline=$(( $(date +%s) + local_timeout ))
  LB_IP=""
  while [[ $(date +%s) -lt ${local_deadline} ]]; do
    LB_IP=$(kubectl get svc caddy-ingress -n caddy-ingress \
      -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
    [[ -n "${LB_IP}" ]] && break
    info "LB IP not yet assigned — retrying in 15s..."
    sleep 15
  done
  if [[ -z "${LB_IP}" ]]; then
    err "Caddy LB IP not assigned after ${local_timeout}s"
    exit 1
  fi
fi
info "LoadBalancer IP: ${LB_IP}"

# ── Step 2: Find zone via hcloud CLI ─────────────────────────────────────────
log "Step 2: Looking up Hetzner DNS zone for '${BASE_DOMAIN}'"

ZONE_ID=$(hcloud zone list -o json 2>/dev/null | \
  python3 -c "import sys,json; zones=json.load(sys.stdin); \
match=[z['id'] for z in zones if z['name']=='${BASE_DOMAIN}']; \
print(match[0] if match else '')" 2>/dev/null || echo "")

if [[ -z "${ZONE_ID}" ]]; then
  err "Zone '${BASE_DOMAIN}' not found."
  err "Available: $(hcloud zone list 2>/dev/null | awk '{print $2}' | tail -n+2 | tr '\n' ' ')"
  exit 1
fi
info "Zone ID: ${ZONE_ID}"

# ── Step 3: Update or create wildcard A record ────────────────────────────────
log "Step 3: Updating *.${BASE_DOMAIN} → ${LB_IP}"

EXISTING=$(hcloud zone rrset describe "${ZONE_ID}" "*" A 2>/dev/null | \
  awk '/- Value:/{print $3}' || echo "")

if [[ "${EXISTING}" == "${LB_IP}" ]]; then
  info "Wildcard record already points to ${LB_IP} — no change needed"
else
  [[ -n "${EXISTING}" ]] && hcloud zone rrset delete "${ZONE_ID}" "*" A 2>/dev/null || true
  hcloud zone rrset create --name "*" --type A --record "${LB_IP}" --ttl "${DNS_TTL}" "${ZONE_ID}"
  info "Set: *.${BASE_DOMAIN} → ${LB_IP} (TTL: ${DNS_TTL}s)"
fi

# Update apex A record if present and stale
APEX=$(hcloud zone rrset describe "${ZONE_ID}" "@" A 2>/dev/null | \
  awk '/- Value:/{print $3}' || echo "")
if [[ -n "${APEX}" && "${APEX}" != "${LB_IP}" ]]; then
  hcloud zone rrset delete "${ZONE_ID}" "@" A 2>/dev/null || true
  hcloud zone rrset create --name "@" --type A --record "${LB_IP}" --ttl "${DNS_TTL}" "${ZONE_ID}"
  info "Updated apex: ${BASE_DOMAIN} → ${LB_IP}"
fi

echo ""
echo "======================================================"
echo "  *.${BASE_DOMAIN}  →  ${LB_IP}  (TTL ${DNS_TTL}s)"
echo "======================================================"
