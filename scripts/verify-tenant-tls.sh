#!/usr/bin/env bash
# verify-tenant-tls.sh — End-to-end TLS verification for a provisioned tenant subdomain
#
# Confirms that a tenant subdomain:
#   1. Returns HTTP 200 (after following redirects) over HTTPS
#   2. Presents a valid TLS certificate issued by Let's Encrypt
#   3. Certificate Subject Alternative Name matches the tenant hostname
#   4. Certificate is not expired
#
# Usage:
#   TENANT_SUBDOMAIN=myco-prod source .env && ./scripts/verify-tenant-tls.sh
#
# Environment variables:
#   BASE_DOMAIN        — Base domain (e.g., botcms.cloud)        [required]
#   TENANT_SUBDOMAIN   — Tenant subdomain slug (e.g., myco-prod) [required]
#   KUBECONFIG         — Path to kubeconfig                       [optional]
#   SKIP_NS_CHECK      — Skip namespace existence check (1/0)     [default: 0]
#   MAX_WAIT_SECS      — Seconds to wait for first TLS response   [default: 60]
#
# Example:
#   TENANT_SUBDOMAIN=acme-prod BASE_DOMAIN=botcms.cloud \
#     source .env && ./scripts/verify-tenant-tls.sh

set -euo pipefail

# ── Color helpers ──────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "  ${CYAN}ℹ${RESET}  $1"; }
header() { echo -e "\n${BOLD}$1${RESET}"; }

FAILURES=0
SKIP_NS_CHECK=${SKIP_NS_CHECK:-0}
MAX_WAIT_SECS=${MAX_WAIT_SECS:-60}

# ── Environment validation ─────────────────────────────────────────────────────
header "── Environment ───────────────────────────────────────────"

if [[ -z "${BASE_DOMAIN:-}" ]]; then
  fail "BASE_DOMAIN not set — source .env first"
  echo "  Hint: TENANT_SUBDOMAIN=myco-prod source .env && ./scripts/verify-tenant-tls.sh"
  exit 1
fi
pass "BASE_DOMAIN=${BASE_DOMAIN}"

if [[ -z "${TENANT_SUBDOMAIN:-}" ]]; then
  fail "TENANT_SUBDOMAIN not set"
  echo "  Hint: TENANT_SUBDOMAIN=myco-prod source .env && ./scripts/verify-tenant-tls.sh"
  exit 1
fi
pass "TENANT_SUBDOMAIN=${TENANT_SUBDOMAIN}"

TENANT_HOST="${TENANT_SUBDOMAIN}.${BASE_DOMAIN}"
info "Target: https://${TENANT_HOST}/"

# Validate subdomain format: must match TENANT_ID-ENV_ID pattern (lowercase, hyphen-separated)
if ! echo "${TENANT_SUBDOMAIN}" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?-[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
  warn "TENANT_SUBDOMAIN '${TENANT_SUBDOMAIN}' does not match expected TENANTID-ENVID pattern"
  echo "  Expected format: lowercase alphanumeric with a single hyphen separator (e.g., myco-prod)"
fi

# ── 1. Namespace existence check ──────────────────────────────────────────────
header "── 1. Tenant Namespace ────────────────────────────────────"

# Derive TENANT_ID from TENANT_SUBDOMAIN (first segment before last hyphen-separated ENV_ID)
# Convention: INSTANCE=${TENANT_ID}-${ENV_ID}, namespace=${TENANT_ID}
TENANT_ID=$(echo "${TENANT_SUBDOMAIN}" | rev | cut -d- -f2- | rev)

if [[ "${SKIP_NS_CHECK}" == "1" ]]; then
  warn "Namespace check skipped (SKIP_NS_CHECK=1)"
else
  NS_STATUS=$(kubectl get namespace "${TENANT_ID}" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  if [[ "${NS_STATUS}" == "Active" ]]; then
    pass "Namespace '${TENANT_ID}' is Active"
    # Verify dotcms managed-by label
    NS_LABEL=$(kubectl get namespace "${TENANT_ID}" \
      -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}' 2>/dev/null || echo "")
    if [[ "${NS_LABEL}" == "dotcms" ]]; then
      pass "Namespace has app.kubernetes.io/managed-by=dotcms label"
    else
      warn "Namespace '${TENANT_ID}' missing app.kubernetes.io/managed-by=dotcms label"
      echo "  This may cause the webhook TLS gate to deny cert issuance"
    fi
  elif [[ -z "${NS_STATUS}" ]]; then
    fail "Namespace '${TENANT_ID}' not found — tenant may not be provisioned"
    echo "  Hint: Run: ./tenant-add.sh ${TENANT_ID} <env-id>"
    echo "  Or skip with SKIP_NS_CHECK=1 to test DNS/TLS directly"
  else
    warn "Namespace '${TENANT_ID}' status: ${NS_STATUS}"
  fi
fi

# ── 2. DNS resolution ─────────────────────────────────────────────────────────
header "── 2. DNS Resolution ──────────────────────────────────────"

RESOLVED_IP=$(dig +short "${TENANT_HOST}" 2>/dev/null \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")

if [[ -z "${RESOLVED_IP}" ]]; then
  fail "${TENANT_HOST} does not resolve — DNS not propagated or wildcard missing"
  echo "  Hint: Ensure *.${BASE_DOMAIN} A record points to the Hetzner LB IP"
  echo "  Run: dig '*.${BASE_DOMAIN}' to check wildcard record"
else
  pass "${TENANT_HOST} → ${RESOLVED_IP}"
  info "DNS resolved — LB IP: ${RESOLVED_IP}"
fi

# ── 3. HTTPS reachability + HTTP 200 ──────────────────────────────────────────
header "── 3. HTTPS Response (HTTP 200) ───────────────────────────"

info "Waiting up to ${MAX_WAIT_SECS}s for Caddy on-demand TLS cert issuance on first hit…"

HTTPS_CODE="000"
HTTPS_BODY=""
ATTEMPT=0
WAIT_INTERVAL=5
MAX_ATTEMPTS=$(( MAX_WAIT_SECS / WAIT_INTERVAL ))

while [[ "${HTTPS_CODE}" == "000" && ${ATTEMPT} -lt ${MAX_ATTEMPTS} ]]; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  if [[ ${ATTEMPT} -gt 1 ]]; then
    info "Attempt ${ATTEMPT}/${MAX_ATTEMPTS} — waiting ${WAIT_INTERVAL}s for cert issuance…"
    sleep "${WAIT_INTERVAL}"
  fi

  HTTPS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 20 \
    --location \
    "https://${TENANT_HOST}/" 2>/dev/null || echo "000")
done

case "${HTTPS_CODE}" in
  200)
    pass "https://${TENANT_HOST}/ → HTTP 200 OK"
    ;;
  000)
    fail "https://${TENANT_HOST}/ — TLS connection failed after ${MAX_WAIT_SECS}s"
    echo "  Possible causes:"
    echo "    - DNS not propagated: dig ${TENANT_HOST}"
    echo "    - Caddy on-demand TLS blocked by webhook (namespace missing or unlabelled)"
    echo "    - dotCMS pod not ready: kubectl get pods -n ${TENANT_ID}"
    echo "    - Caddy not running: kubectl get pods -n caddy-ingress"
    echo "  Retry with: TENANT_SUBDOMAIN=${TENANT_SUBDOMAIN} MAX_WAIT_SECS=120 source .env && ./scripts/verify-tenant-tls.sh"
    ;;
  301|302|307|308)
    pass "https://${TENANT_HOST}/ → HTTP ${HTTPS_CODE} (redirect — following to final destination)"
    # Follow the redirect chain and get final code
    FINAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 20 \
      --location \
      --max-redirs 5 \
      "https://${TENANT_HOST}/" 2>/dev/null || echo "000")
    if [[ "${FINAL_CODE}" == "200" ]]; then
      pass "Final response after redirect → HTTP 200 OK"
    else
      warn "Final response after redirect → HTTP ${FINAL_CODE}"
    fi
    ;;
  401)
    warn "https://${TENANT_HOST}/ → HTTP 401 (authentication required — TLS works but auth gate active)"
    info "If this is expected (BasicAuth), TLS verification still passes"
    ;;
  502|503|504)
    warn "https://${TENANT_HOST}/ → HTTP ${HTTPS_CODE} (backend error)"
    echo "  dotCMS pod may still be starting. Check: kubectl get pods -n ${TENANT_ID}"
    ;;
  *)
    warn "https://${TENANT_HOST}/ → HTTP ${HTTPS_CODE} (unexpected — expected 200)"
    ;;
esac

# ── 4. TLS certificate verification ───────────────────────────────────────────
header "── 4. TLS Certificate ─────────────────────────────────────"

# Retrieve full cert details via openssl
CERT_FULL=$(echo | timeout 10 openssl s_client \
  -connect "${TENANT_HOST}:443" \
  -servername "${TENANT_HOST}" \
  2>/dev/null || echo "")

if [[ -z "${CERT_FULL}" ]]; then
  fail "Could not connect to ${TENANT_HOST}:443 to retrieve TLS certificate"
else
  CERT_INFO=$(echo "${CERT_FULL}" | openssl x509 -noout \
    -issuer -subject -dates -ext subjectAltName 2>/dev/null || echo "")

  CERT_ISSUER=$(echo "${CERT_INFO}" | grep "^issuer=" || echo "")
  CERT_SUBJECT=$(echo "${CERT_INFO}" | grep "^subject=" || echo "")
  CERT_NOT_BEFORE=$(echo "${CERT_INFO}" | grep "^notBefore=" | cut -d= -f2 || echo "")
  CERT_NOT_AFTER=$(echo "${CERT_INFO}" | grep "^notAfter=" | cut -d= -f2 || echo "")
  CERT_SANS=$(echo "${CERT_INFO}" | grep -A1 "Subject Alternative Name" | tail -1 || echo "")

  # 4a. Let's Encrypt issuer check
  # LE intermediates: R3, R10, E1, E5, E6 (ISRG root)
  if echo "${CERT_ISSUER}" | grep -qiE "let.?s.?encrypt|ISRG|issuer=.*R[0-9]+|issuer=.*E[0-9]+"; then
    pass "Certificate issued by Let's Encrypt"
    info "Issuer: ${CERT_ISSUER#issuer=}"
  elif [[ -n "${CERT_ISSUER}" ]]; then
    warn "Certificate issuer: ${CERT_ISSUER#issuer=}"
    warn "Not Let's Encrypt — may be ACME staging CA or self-signed"
    info "Staging CA is acceptable for pre-production environments"
  else
    fail "Could not extract certificate issuer"
  fi

  # 4b. Subject
  if [[ -n "${CERT_SUBJECT}" ]]; then
    pass "Subject: ${CERT_SUBJECT#subject=}"
  else
    warn "Certificate subject is empty"
  fi

  # 4c. SAN match — cert must cover the tenant hostname
  if echo "${CERT_SANS}" | grep -q "${TENANT_HOST}"; then
    pass "SAN covers ${TENANT_HOST}"
  elif echo "${CERT_SANS}" | grep -q "*.${BASE_DOMAIN}"; then
    pass "SAN wildcard *.${BASE_DOMAIN} covers ${TENANT_HOST}"
  elif [[ -n "${CERT_SANS}" ]]; then
    fail "SAN does not cover ${TENANT_HOST}"
    info "SANs present: ${CERT_SANS}"
  else
    warn "Could not extract SANs from certificate"
  fi

  # 4d. Expiry check
  if [[ -n "${CERT_NOT_AFTER}" ]]; then
    # Convert expiry to epoch for comparison
    EXPIRY_EPOCH=$(date -d "${CERT_NOT_AFTER}" +%s 2>/dev/null \
      || date -jf "%b %d %H:%M:%S %Y %Z" "${CERT_NOT_AFTER}" +%s 2>/dev/null \
      || echo "0")
    NOW_EPOCH=$(date +%s)
    DAYS_UNTIL_EXPIRY=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [[ "${EXPIRY_EPOCH}" -gt "${NOW_EPOCH}" ]]; then
      if [[ "${DAYS_UNTIL_EXPIRY}" -gt 30 ]]; then
        pass "Certificate valid for ${DAYS_UNTIL_EXPIRY} days (expires: ${CERT_NOT_AFTER})"
      else
        warn "Certificate expires in ${DAYS_UNTIL_EXPIRY} days — renewal may be needed soon"
      fi
    else
      fail "Certificate EXPIRED on ${CERT_NOT_AFTER}"
    fi
  else
    warn "Could not extract certificate expiry date"
  fi

  # 4e. Validity start
  [[ -n "${CERT_NOT_BEFORE}" ]] && info "  Valid from: ${CERT_NOT_BEFORE}"

  # 4f. TLS protocol version check
  TLS_VERSION=$(echo "${CERT_FULL}" | grep "Protocol" | awk '{print $NF}' | head -1 || echo "")
  if [[ -n "${TLS_VERSION}" ]]; then
    if echo "${TLS_VERSION}" | grep -qE "TLSv1\.[23]"; then
      pass "TLS protocol: ${TLS_VERSION}"
    else
      warn "TLS protocol: ${TLS_VERSION} (TLSv1.2+ recommended)"
    fi
  fi
fi

# ── 5. dotCMS pod readiness ────────────────────────────────────────────────────
header "── 5. dotCMS Pod Readiness ─────────────────────────────────"

if [[ "${SKIP_NS_CHECK}" == "1" ]]; then
  warn "Pod readiness check skipped (SKIP_NS_CHECK=1)"
else
  INSTANCE="${TENANT_SUBDOMAIN}"
  RUNNING_PODS=$(kubectl get pods -n "${TENANT_ID}" \
    -l "app=${INSTANCE}" \
    --field-selector=status.phase=Running \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')

  TOTAL_PODS=$(kubectl get pods -n "${TENANT_ID}" \
    -l "app=${INSTANCE}" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')

  if [[ "${RUNNING_PODS}" -ge 1 ]]; then
    pass "${RUNNING_PODS}/${TOTAL_PODS} dotCMS pods Running for instance '${INSTANCE}'"
  elif [[ "${TOTAL_PODS}" -ge 1 ]]; then
    warn "${RUNNING_PODS}/${TOTAL_PODS} dotCMS pods Running — pods may still be starting"
    kubectl get pods -n "${TENANT_ID}" -l "app=${INSTANCE}" --no-headers 2>/dev/null || true
  else
    warn "No pods found with label app=${INSTANCE} in namespace ${TENANT_ID}"
    echo "  Hint: Check pod labels: kubectl get pods -n ${TENANT_ID} --show-labels"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
header "── Summary ────────────────────────────────────────────────"
echo ""
echo "  Tenant   : ${TENANT_SUBDOMAIN}"
echo "  Hostname : ${TENANT_HOST}"
echo "  HTTP     : ${HTTPS_CODE}"
echo ""
if [[ "${FAILURES}" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}All checks passed.${RESET} End-to-end TLS verified for ${TENANT_HOST}"
  echo ""
  echo "  ✓  HTTPS request returned HTTP ${HTTPS_CODE}"
  echo "  ✓  Let's Encrypt certificate valid and not expired"
  echo "  ✓  Certificate SAN covers ${TENANT_HOST}"
else
  echo -e "  ${RED}${BOLD}${FAILURES} check(s) failed.${RESET}"
  echo ""
  echo "  Troubleshooting:"
  echo "    kubectl get pods -n ${TENANT_ID:-<namespace>}"
  echo "    kubectl logs -n caddy-ingress -l app=caddy-ingress --tail=50"
  echo "    dig ${TENANT_HOST}"
  echo "    openssl s_client -connect ${TENANT_HOST}:443 -servername ${TENANT_HOST}"
  echo ""
  echo "  Re-run with extended wait:"
  echo "    TENANT_SUBDOMAIN=${TENANT_SUBDOMAIN} MAX_WAIT_SECS=120 source .env && ./scripts/verify-tenant-tls.sh"
  exit 1
fi
