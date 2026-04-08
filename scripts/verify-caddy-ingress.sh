#!/usr/bin/env bash
# verify-caddy-ingress.sh — Verify Caddy ingress routing, LB IP reachability, and wildcard DNS
#
# Usage:
#   source .env && ./scripts/verify-caddy-ingress.sh
#   SKIP_DNS=1 ./scripts/verify-caddy-ingress.sh   # skip DNS resolution checks (useful pre-propagation)
#
# Checks performed:
#   1. Caddy pods are Running (2+ replicas)
#   2. LoadBalancer IP is assigned to caddy-ingress Service
#   3. LB IP is reachable on port 80 (/health returns 200)
#   4. HTTP → HTTPS redirect works (301/308 from port 80 for non-health paths)
#   5. Port 443 TLS reachable
#   6. Wildcard DNS *.BASE_DOMAIN resolves to LB IP
#   7. End-to-end HTTPS routing (observe + test subdomain)
#   8. Webhook TLS gate: on_demand_tls ask URL wired, pod running, deny/allow/revoke cycle
#   9. TLS cert issuance for a known tenant (set TENANT_SUBDOMAIN=tenant-env to run)

set -euo pipefail

# ── Color helpers ──────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail() { echo -e "  ${RED}✗${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
header() { echo -e "\n${BOLD}$1${RESET}"; }

FAILURES=0
SKIP_DNS=${SKIP_DNS:-0}

# ── Env validation ─────────────────────────────────────────────────────────────
header "── Environment ───────────────────────────────────────────"

if [[ -z "${BASE_DOMAIN:-}" ]]; then
  fail "BASE_DOMAIN not set — source .env first"
  echo "  Hint: source .env && ./scripts/verify-caddy-ingress.sh"
  exit 1
fi
pass "BASE_DOMAIN=${BASE_DOMAIN}"

if [[ -z "${KUBECONFIG:-}" ]]; then
  warn "KUBECONFIG not set; using default (~/.kube/config)"
else
  pass "KUBECONFIG=${KUBECONFIG}"
fi

# ── 1. Caddy pods ──────────────────────────────────────────────────────────────
header "── 1. Caddy Pods ──────────────────────────────────────────"

CADDY_PODS=$(kubectl get pods -n caddy-ingress -l app=caddy-ingress \
  --field-selector=status.phase=Running \
  --no-headers 2>/dev/null | wc -l | tr -d ' ')

if [[ "${CADDY_PODS}" -ge 2 ]]; then
  pass "${CADDY_PODS} caddy-ingress pods Running"
elif [[ "${CADDY_PODS}" -eq 1 ]]; then
  warn "Only 1/2 caddy-ingress pods Running (degraded — check 'kubectl get pods -n caddy-ingress')"
else
  fail "No caddy-ingress pods Running"
  kubectl get pods -n caddy-ingress 2>/dev/null || true
fi

# Valkey cert storage
VALKEY_POD=$(kubectl get pod caddy-redis-0 -n caddy-ingress \
  --no-headers 2>/dev/null | awk '{print $3}' || echo "")
if [[ "${VALKEY_POD}" == "Running" ]]; then
  pass "Valkey cert storage (caddy-redis-0) Running"
else
  fail "Valkey cert storage (caddy-redis-0) not Running (status: ${VALKEY_POD:-not found})"
fi

# ── 2. LoadBalancer IP ─────────────────────────────────────────────────────────
header "── 2. LoadBalancer IP ─────────────────────────────────────"

LB_IP=$(kubectl get svc caddy-ingress -n caddy-ingress \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")

if [[ -z "${LB_IP}" ]]; then
  fail "caddy-ingress Service has no LoadBalancer IP assigned yet"
  echo "  Hint: Hetzner CCM may need a moment to provision the LB"
  echo "  Run: kubectl get svc -n caddy-ingress caddy-ingress -w"
  exit 1
fi
pass "LoadBalancer IP: ${LB_IP}"

# ── 3. Port 80 /health reachability ───────────────────────────────────────────
header "── 3. HTTP Reachability (port 80) ─────────────────────────"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 10 "http://${LB_IP}/health" 2>/dev/null || echo "000")

if [[ "${HTTP_CODE}" == "200" ]]; then
  pass "/health endpoint returns 200 on port 80"
else
  fail "/health endpoint returned HTTP ${HTTP_CODE} (expected 200)"
  echo "  Hint: Caddy may still be starting — check: kubectl logs -n caddy-ingress -l app=caddy-ingress"
fi

# ── 4. HTTP → HTTPS redirect ───────────────────────────────────────────────────
header "── 4. HTTP → HTTPS Redirect ───────────────────────────────"

# Use a test subdomain path; Caddy should 301/308 to https://
REDIR_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 10 -H "Host: test.${BASE_DOMAIN}" \
  "http://${LB_IP}/" 2>/dev/null || echo "000")

if [[ "${REDIR_CODE}" == "301" || "${REDIR_CODE}" == "308" ]]; then
  pass "HTTP → HTTPS redirect works (${REDIR_CODE})"
elif [[ "${REDIR_CODE}" == "200" ]]; then
  warn "HTTP returned 200 (no redirect) — expected 301/308 for non-health paths"
else
  fail "HTTP redirect returned unexpected code: ${REDIR_CODE}"
fi

# ── 5. Port 443 TLS reachability ──────────────────────────────────────────────
header "── 5. HTTPS Reachability (port 443) ──────────────────────"

# Connect with --insecure since on-demand TLS needs a hostname for SNI;
# using the raw IP skips SNI, so we just verify the port is open and TLS works.
TLS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 15 --insecure \
  "https://${LB_IP}/" 2>/dev/null || echo "000")

if [[ "${TLS_CODE}" != "000" ]]; then
  pass "Port 443 TLS reachable (HTTP ${TLS_CODE})"
else
  fail "Port 443 not reachable — TLS connection failed"
  echo "  Hint: firewall or Hetzner LB may be blocking 443"
fi

# ── 6. Wildcard DNS resolution ────────────────────────────────────────────────
header "── 6. Wildcard DNS Resolution ─────────────────────────────"

if [[ "${SKIP_DNS}" == "1" ]]; then
  warn "DNS checks skipped (SKIP_DNS=1)"
else
  # Helper: resolve hostname and compare to LB IP
  check_dns() {
    local hostname="$1"
    local resolved
    resolved=$(dig +short "${hostname}" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
    if [[ "${resolved}" == "${LB_IP}" ]]; then
      pass "${hostname} → ${resolved}"
    elif [[ -z "${resolved}" ]]; then
      fail "${hostname} → (no DNS response)"
    else
      fail "${hostname} → ${resolved} (expected ${LB_IP})"
    fi
  }

  # Check wildcard by using a random-ish prefix
  check_dns "test.${BASE_DOMAIN}"
  check_dns "observe.${BASE_DOMAIN}"
  check_dns "manage.${BASE_DOMAIN}"
  check_dns "acme-client.${BASE_DOMAIN}"

  # Verify using authoritative Hetzner NS if available
  HETZNER_NS="helium.ns.hetzner.de"
  AUTH_IP=$(dig +short "@${HETZNER_NS}" "test.${BASE_DOMAIN}" 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
  if [[ "${AUTH_IP}" == "${LB_IP}" ]]; then
    pass "Authoritative DNS (${HETZNER_NS}): test.${BASE_DOMAIN} → ${AUTH_IP}"
  elif [[ -z "${AUTH_IP}" ]]; then
    warn "Authoritative DNS query to ${HETZNER_NS} returned no result — propagation may be pending"
  else
    fail "Authoritative DNS: test.${BASE_DOMAIN} → ${AUTH_IP} (expected ${LB_IP})"
  fi
fi

# ── 7. End-to-end: subdomain HTTPS response ───────────────────────────────────
header "── 7. End-to-End HTTPS Routing ────────────────────────────"

if [[ "${SKIP_DNS}" == "1" ]]; then
  warn "End-to-end HTTPS skipped (requires DNS — set SKIP_DNS=0)"
else
  # Caddy should respond to a tenant subdomain with either 404 (tenant not found)
  # or redirect. A 404 from Caddy itself confirms routing works; a connection
  # error means TLS or routing failed.
  E2E_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 20 \
    "https://test.${BASE_DOMAIN}/" 2>/dev/null || echo "000")

  case "${E2E_CODE}" in
    404)
      pass "https://test.${BASE_DOMAIN}/ → 404 (tenant not found — Caddy routing works)"
      ;;
    000)
      fail "https://test.${BASE_DOMAIN}/ — connection failed (TLS or DNS issue)"
      echo "  Hint: DNS may not have propagated yet — retry with SKIP_DNS=1 to skip"
      ;;
    *)
      warn "https://test.${BASE_DOMAIN}/ → ${E2E_CODE} (unexpected; Caddy may have a tenant configured)"
      ;;
  esac

  # observe.BASE_DOMAIN should prompt for BasicAuth (401) if configured
  OBS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 20 \
    "https://observe.${BASE_DOMAIN}/" 2>/dev/null || echo "000")
  case "${OBS_CODE}" in
    401) pass "https://observe.${BASE_DOMAIN}/ → 401 (BasicAuth gating Grafana — correct)" ;;
    200) warn "https://observe.${BASE_DOMAIN}/ → 200 (BasicAuth may not be configured)" ;;
    000) fail "https://observe.${BASE_DOMAIN}/ — connection failed" ;;
    *)   warn "https://observe.${BASE_DOMAIN}/ → ${OBS_CODE}" ;;
  esac
fi

# ── 8. Webhook TLS gate validation ────────────────────────────────────────────
# Verifies that Caddy's on_demand_tls ask endpoint correctly gates certificate
# issuance: 200 for valid tenant namespaces, 403 for unknown domains.
header "── 8. Webhook TLS Gate ─────────────────────────────────────"

WEBHOOK_PODS=$(kubectl get pods -n caddy -l app.kubernetes.io/name=caddy-webhook \
  --field-selector=status.phase=Running \
  --no-headers 2>/dev/null | wc -l | tr -d ' ')

if [[ "${WEBHOOK_PODS}" -ge 1 ]]; then
  pass "${WEBHOOK_PODS} caddy-webhook pod(s) Running in caddy namespace"
else
  fail "No caddy-webhook pods Running in caddy namespace"
  kubectl get pods -n caddy 2>/dev/null || true
fi

# Confirm the Service exists and targets the correct port
WEBHOOK_SVC=$(kubectl get svc caddy-webhook -n caddy \
  -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "")
if [[ "${WEBHOOK_SVC}" == "80" ]]; then
  pass "caddy-webhook ClusterIP Service present (port 80 → 8080)"
else
  fail "caddy-webhook Service missing or wrong port (got: ${WEBHOOK_SVC:-not found})"
fi

# Confirm on_demand_tls ask URL in Caddy ConfigMap matches webhook Service
ASK_URL=$(kubectl get configmap caddy-config -n caddy-ingress \
  -o jsonpath='{.data.Caddyfile}' 2>/dev/null \
  | grep "ask " | tr -d ' ' | sed 's/ask//')
EXPECTED_ASK="http://caddy-webhook.caddy.svc.cluster.local/check"
if [[ "${ASK_URL}" == "${EXPECTED_ASK}" ]]; then
  pass "on_demand_tls ask URL correct: ${ASK_URL}"
else
  fail "on_demand_tls ask URL mismatch"
  echo "  Expected: ${EXPECTED_ASK}"
  echo "  Got:      ${ASK_URL:-<empty>}"
fi

# Test webhook directly via port-forward (non-blocking: skip if port-forward fails)
if [[ "${WEBHOOK_PODS}" -ge 1 ]]; then
  # Pick a pod and port-forward in background
  WH_POD=$(kubectl get pods -n caddy -l app.kubernetes.io/name=caddy-webhook \
    --no-headers 2>/dev/null | awk 'NR==1{print $1}')
  kubectl port-forward -n caddy "pod/${WH_POD}" 18080:8080 >/dev/null 2>&1 &
  PF_PID=$!
  sleep 2  # allow port-forward to establish

  if kill -0 "${PF_PID}" 2>/dev/null; then
    # Test /healthz
    HEALTH=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 5 "http://localhost:18080/healthz" 2>/dev/null || echo "000")
    if [[ "${HEALTH}" == "200" ]]; then
      pass "Webhook /healthz → 200"
    else
      fail "Webhook /healthz → ${HEALTH} (expected 200)"
    fi

    # Test /check with unknown domain — should be denied (403)
    DENY_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 5 \
      "http://localhost:18080/check?domain=nonexistent-xyz-99.${BASE_DOMAIN}" \
      2>/dev/null || echo "000")
    if [[ "${DENY_CODE}" == "403" ]]; then
      pass "Webhook /check for unknown tenant → 403 (TLS gate blocking unknown namespace)"
    elif [[ "${DENY_CODE}" == "000" ]]; then
      fail "Webhook /check — connection failed"
    else
      warn "Webhook /check for unknown tenant → ${DENY_CODE} (expected 403)"
    fi

    # Test /check with caddy-ingress namespace — it exists but is NOT a dotcms tenant
    CADDY_NS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 5 \
      "http://localhost:18080/check?domain=caddy-ingress.${BASE_DOMAIN}" \
      2>/dev/null || echo "000")
    if [[ "${CADDY_NS_CODE}" == "403" ]]; then
      pass "Webhook /check for non-dotcms namespace → 403 (managed-by label gate working)"
    else
      warn "Webhook /check for caddy-ingress namespace → ${CADDY_NS_CODE} (expected 403; namespace exists but lacks dotcms label)"
    fi

    # Positive test: create a temporary dotcms-labelled namespace, verify webhook allows it,
    # then delete it and verify the webhook denies again. This confirms the full gate cycle.
    kubectl create namespace verify-tls-test --dry-run=client -o yaml \
      | kubectl apply -f - >/dev/null 2>&1 || true
    kubectl label namespace verify-tls-test \
      app.kubernetes.io/managed-by=dotcms --overwrite >/dev/null 2>&1 || true

    ALLOW_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 5 \
      "http://localhost:18080/check?domain=verify-tls-test.${BASE_DOMAIN}" \
      2>/dev/null || echo "000")
    if [[ "${ALLOW_CODE}" == "200" ]]; then
      pass "Webhook /check for valid dotcms namespace → 200 (cert gate OPEN for known tenant)"
    elif [[ "${ALLOW_CODE}" == "000" ]]; then
      fail "Webhook /check — connection failed during positive test"
    else
      fail "Webhook /check for valid tenant → ${ALLOW_CODE} (expected 200)"
    fi

    # Delete test namespace and confirm gate closes (cert revocation gate works)
    kubectl delete namespace verify-tls-test --ignore-not-found >/dev/null 2>&1 || true
    sleep 1  # allow API server to propagate deletion
    POST_DELETE=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 5 \
      "http://localhost:18080/check?domain=verify-tls-test.${BASE_DOMAIN}" \
      2>/dev/null || echo "000")
    if [[ "${POST_DELETE}" == "403" ]]; then
      pass "Webhook /check after namespace deletion → 403 (gate closes when tenant removed)"
    else
      warn "Webhook /check after deletion → ${POST_DELETE} (namespace may still be terminating)"
    fi

    kill "${PF_PID}" 2>/dev/null || true
  else
    warn "Port-forward to caddy-webhook failed — skipping live endpoint checks"
  fi
fi

# ── 9. TLS Certificate Issuance for Known Tenant ──────────────────────────────
# Verifies that a real tenant subdomain receives a valid TLS certificate from
# Let's Encrypt via Caddy on-demand TLS. Requires DNS propagation and an active
# tenant namespace. Set TENANT_SUBDOMAIN=tenant-env to run this check.
#
# Example:
#   TENANT_SUBDOMAIN=acme-prod source .env && ./scripts/verify-caddy-ingress.sh
header "── 9. TLS Certificate Issuance ──────────────────────────────"

TENANT_SUBDOMAIN=${TENANT_SUBDOMAIN:-}

if [[ -z "${TENANT_SUBDOMAIN}" ]]; then
  warn "TENANT_SUBDOMAIN not set — skipping TLS cert issuance check"
  echo "       Hint: TENANT_SUBDOMAIN=myco-prod source .env && ./scripts/verify-caddy-ingress.sh"
elif [[ "${SKIP_DNS}" == "1" ]]; then
  warn "TLS cert issuance check skipped (requires DNS — set SKIP_DNS=0)"
else
  TENANT_HOST="${TENANT_SUBDOMAIN}.${BASE_DOMAIN}"
  echo "       Checking TLS cert for ${TENANT_HOST} …"

  # Trigger on-demand TLS: Caddy issues the cert on first HTTPS hit.
  CERT_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 30 \
    "https://${TENANT_HOST}/" 2>/dev/null || echo "000")

  if [[ "${CERT_CODE}" == "000" ]]; then
    fail "https://${TENANT_HOST}/ — TLS connection failed (cert not yet issued or DNS not propagated)"
    echo "       Hint: Caddy issues certs on first HTTPS hit. Wait 30s and retry."
  else
    # Verify the certificate is valid and issued by Let's Encrypt
    CERT_INFO=$(echo | openssl s_client \
      -connect "${TENANT_HOST}:443" \
      -servername "${TENANT_HOST}" \
      2>/dev/null | openssl x509 -noout -issuer -subject -dates 2>/dev/null || echo "")

    CERT_ISSUER=$(echo "${CERT_INFO}" | grep "^issuer=" || echo "")
    CERT_SUBJECT=$(echo "${CERT_INFO}" | grep "^subject=" || echo "")
    CERT_EXPIRY=$(echo "${CERT_INFO}" | grep "notAfter=" | cut -d= -f2 || echo "")

    if echo "${CERT_ISSUER}" | grep -qiE "let.?s.?encrypt|ISRG|^issuer=.*R[0-9]|^issuer=.*E[0-9]"; then
      pass "TLS cert for ${TENANT_HOST} issued by Let's Encrypt"
    elif [[ -n "${CERT_ISSUER}" ]]; then
      warn "TLS cert issuer: ${CERT_ISSUER}"
      warn "Not Let's Encrypt — may be ACME staging or custom CA"
    else
      fail "Could not retrieve TLS cert from ${TENANT_HOST} (HTTP ${CERT_CODE})"
    fi

    [[ -n "${CERT_SUBJECT}" ]] && pass "  Subject: ${CERT_SUBJECT}"
    [[ -n "${CERT_EXPIRY}" ]]  && pass "  Expires: ${CERT_EXPIRY}"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
header "── Summary ────────────────────────────────────────────────"
echo ""
if [[ "${FAILURES}" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}All checks passed.${RESET} Caddy ingress is routing correctly."
  echo ""
  echo "  LoadBalancer IP : ${LB_IP}"
  echo "  Wildcard domain : *.${BASE_DOMAIN} → ${LB_IP}"
  echo "  Health endpoint : http://${LB_IP}/health"
else
  echo -e "  ${RED}${BOLD}${FAILURES} check(s) failed.${RESET}"
  echo ""
  echo "  Troubleshooting:"
  echo "    kubectl get pods -n caddy-ingress"
  echo "    kubectl logs -n caddy-ingress -l app=caddy-ingress --tail=50"
  echo "    kubectl get svc -n caddy-ingress caddy-ingress"
  echo "    kubectl describe svc -n caddy-ingress caddy-ingress"
  echo ""
  echo "  If DNS hasn't propagated yet, re-run with SKIP_DNS=1:"
  echo "    SKIP_DNS=1 source .env && ./scripts/verify-caddy-ingress.sh"
  exit 1
fi
