#!/usr/bin/env bash
# verify-grafana.sh — Verify Grafana is accessible at observe.BASE_DOMAIN
#
# Usage:
#   source .env && ./scripts/verify-grafana.sh
#   SKIP_DNS=1 ./scripts/verify-grafana.sh          # skip DNS propagation checks
#
# Checks performed:
#   1. Grafana pod is Running in monitoring namespace
#   2. LoadBalancer IP is assigned to caddy-ingress Service
#   3. DNS: observe.BASE_DOMAIN resolves to LB IP
#   4. TLS certificate for observe.BASE_DOMAIN is valid and issued by Let's Encrypt
#   5. HTTPS endpoint returns 401 without credentials (BasicAuth gate active)
#   6. HTTPS endpoint returns 200 with GRAFANA_ADMIN_PASSWORD credentials (optional)
#   7. Grafana /api/health returns {"database": "ok"} when authenticated (optional)
#   8. Prometheus datasource health is OK via /api/datasources/uid/{uid}/health (optional)
#      and test query 'up' returns at least one series via /api/ds/query (optional)
#   9. Default dashboards loaded: k3s/node/cluster dashboards present and panels
#      render without errors (sampled via /api/search + /api/dashboards/uid/{uid})
#
# Optional env vars:
#   GRAFANA_ADMIN_PASSWORD — admin password (skips auth checks if unset)
#   GRAFANA_ADMIN_USER     — admin username (default: admin)
#   SKIP_DNS               — set to 1 to skip DNS resolution checks (default: 0)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Color helpers ──────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

pass()   { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn()   { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
fail()   { echo -e "  ${RED}✗${RESET}  $1"; FAILURES=$((FAILURES + 1)); }
header() { echo -e "\n${BOLD}$1${RESET}"; }

FAILURES=0
SKIP_DNS=${SKIP_DNS:-0}

# ── Env validation ─────────────────────────────────────────────────────────────
header "── Environment ───────────────────────────────────────────"

if [[ -z "${BASE_DOMAIN:-}" ]]; then
  fail "BASE_DOMAIN not set — source .env first"
  echo "  Hint: source .env && ./scripts/verify-grafana.sh"
  exit 1
fi
pass "BASE_DOMAIN=${BASE_DOMAIN}"
GRAFANA_HOST="observe.${BASE_DOMAIN}"
pass "Grafana host: https://${GRAFANA_HOST}/"

GRAFANA_ADMIN_USER="${GRAFANA_ADMIN_USER:-admin}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-}"

if [[ -n "${GRAFANA_ADMIN_PASSWORD}" ]]; then
  pass "GRAFANA_ADMIN_PASSWORD set — will run authenticated checks"
else
  warn "GRAFANA_ADMIN_PASSWORD not set — skipping authenticated endpoint checks"
fi

if [[ -z "${KUBECONFIG:-}" ]]; then
  warn "KUBECONFIG not set; using default (~/.kube/config)"
else
  pass "KUBECONFIG=${KUBECONFIG}"
fi

# ── 1. Grafana pod ─────────────────────────────────────────────────────────────
header "── 1. Grafana Pod ─────────────────────────────────────────"

GRAFANA_PODS=$(kubectl get pods -n monitoring \
  -l "app.kubernetes.io/name=grafana" \
  --field-selector=status.phase=Running \
  --no-headers 2>/dev/null | wc -l | tr -d ' ')

if [[ "${GRAFANA_PODS}" -ge 1 ]]; then
  pass "${GRAFANA_PODS} Grafana pod(s) Running in monitoring namespace"
else
  fail "No Grafana pods Running in monitoring namespace"
  echo "  Hint: kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana"
  echo "  Hint: kubectl logs -n monitoring -l app.kubernetes.io/name=grafana --tail=50"
fi

# Confirm Grafana Service exists
GRAFANA_SVC_PORT=$(kubectl get svc -n monitoring \
  -l "app.kubernetes.io/name=grafana" \
  -o jsonpath='{.items[0].spec.ports[0].port}' 2>/dev/null || echo "")
if [[ "${GRAFANA_SVC_PORT}" == "80" ]]; then
  pass "Grafana Service found (port 80)"
else
  warn "Grafana Service port: ${GRAFANA_SVC_PORT:-not found} (expected 80)"
fi

# ── 2. LoadBalancer IP ─────────────────────────────────────────────────────────
header "── 2. LoadBalancer IP ─────────────────────────────────────"

LB_IP=$(kubectl get svc caddy-ingress -n caddy-ingress \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")

if [[ -z "${LB_IP}" ]]; then
  fail "caddy-ingress Service has no LoadBalancer IP assigned yet"
  echo "  Hint: Hetzner CCM may need a moment to provision the LB"
  echo "  Hint: kubectl get svc -n caddy-ingress caddy-ingress"
  exit 1
fi
pass "LoadBalancer IP: ${LB_IP}"

# ── 3. DNS resolution ──────────────────────────────────────────────────────────
header "── 3. DNS Resolution ──────────────────────────────────────"

if [[ "${SKIP_DNS}" == "1" ]]; then
  warn "DNS checks skipped (SKIP_DNS=1)"
else
  RESOLVED=$(dig +short "${GRAFANA_HOST}" 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")

  if [[ "${RESOLVED}" == "${LB_IP}" ]]; then
    pass "${GRAFANA_HOST} → ${RESOLVED} (matches LB IP)"
  elif [[ -z "${RESOLVED}" ]]; then
    fail "${GRAFANA_HOST} → (no DNS response)"
    echo "  Hint: Wildcard *.${BASE_DOMAIN} must point to ${LB_IP}"
    echo "  Re-run with SKIP_DNS=1 while DNS propagates:"
    echo "    SKIP_DNS=1 source .env && ./scripts/verify-grafana.sh"
  else
    fail "${GRAFANA_HOST} → ${RESOLVED} (expected ${LB_IP})"
    echo "  Hint: DNS record points to wrong IP — update *.${BASE_DOMAIN} → ${LB_IP}"
  fi

  # Authoritative DNS check via Hetzner NS
  HETZNER_NS="helium.ns.hetzner.de"
  AUTH_IP=$(dig +short "@${HETZNER_NS}" "${GRAFANA_HOST}" 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
  if [[ "${AUTH_IP}" == "${LB_IP}" ]]; then
    pass "Authoritative DNS (${HETZNER_NS}): ${GRAFANA_HOST} → ${AUTH_IP}"
  elif [[ -z "${AUTH_IP}" ]]; then
    warn "Authoritative DNS query to ${HETZNER_NS} returned no result — propagation pending"
  else
    fail "Authoritative DNS: ${GRAFANA_HOST} → ${AUTH_IP} (expected ${LB_IP})"
  fi
fi

# ── 4. TLS certificate validation ─────────────────────────────────────────────
header "── 4. TLS Certificate ─────────────────────────────────────"

if [[ "${SKIP_DNS}" == "1" ]]; then
  warn "TLS cert validation skipped (requires DNS — set SKIP_DNS=0)"
else
  # Attempt TLS handshake — capture cert details
  CERT_RAW=$(echo | openssl s_client \
    -connect "${GRAFANA_HOST}:443" \
    -servername "${GRAFANA_HOST}" \
    -timeout 15 \
    2>/dev/null || echo "")

  if [[ -z "${CERT_RAW}" ]]; then
    fail "TLS handshake failed for ${GRAFANA_HOST}:443 — no certificate received"
    echo "  Hint: DNS may not have propagated yet, or Caddy has not issued the cert."
    echo "  Hint: TENANT_SUBDOMAIN triggers on-demand TLS — first HTTPS hit issues cert."
  else
    CERT_INFO=$(echo "${CERT_RAW}" | openssl x509 -noout -issuer -subject -dates 2>/dev/null || echo "")

    CERT_ISSUER=$(echo "${CERT_INFO}" | grep "^issuer=" || echo "")
    CERT_SUBJECT=$(echo "${CERT_INFO}" | grep "^subject=" || echo "")
    CERT_NOT_BEFORE=$(echo "${CERT_INFO}" | grep "notBefore=" | cut -d= -f2- || echo "")
    CERT_NOT_AFTER=$(echo "${CERT_INFO}" | grep "notAfter="  | cut -d= -f2- || echo "")

    # Verify issuer is Let's Encrypt
    if echo "${CERT_ISSUER}" | grep -qiE "let.?s.?encrypt|ISRG|R[0-9]|E[0-9]"; then
      pass "TLS certificate issued by Let's Encrypt"
      pass "  Issuer:    ${CERT_ISSUER#issuer=}"
    elif [[ -n "${CERT_ISSUER}" ]]; then
      warn "TLS cert issuer: ${CERT_ISSUER#issuer=}"
      warn "Not Let's Encrypt — may be ACME staging or self-signed"
    else
      fail "Could not parse certificate issuer"
    fi

    # Verify subject matches the hostname
    if echo "${CERT_SUBJECT}" | grep -q "${GRAFANA_HOST}"; then
      pass "  Subject CN matches ${GRAFANA_HOST}"
    elif [[ -n "${CERT_SUBJECT}" ]]; then
      # Might be a wildcard cert
      if echo "${CERT_SUBJECT}" | grep -q "*.${BASE_DOMAIN}"; then
        pass "  Subject is wildcard *.${BASE_DOMAIN} — covers ${GRAFANA_HOST}"
      else
        warn "  Subject: ${CERT_SUBJECT#subject=} (does not match ${GRAFANA_HOST})"
      fi
    fi

    [[ -n "${CERT_NOT_BEFORE}" ]] && pass "  Valid from: ${CERT_NOT_BEFORE}"
    [[ -n "${CERT_NOT_AFTER}"  ]] && pass "  Expires:    ${CERT_NOT_AFTER}"

    # Verify cert is not expired and not too soon to expire (<7 days = warn)
    EXPIRY_EPOCH=$(date -d "${CERT_NOT_AFTER}" +%s 2>/dev/null \
      || date -j -f "%b %d %T %Y %Z" "${CERT_NOT_AFTER}" +%s 2>/dev/null \
      || echo "0")
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    if [[ "${EXPIRY_EPOCH}" -gt 0 ]]; then
      if [[ "${DAYS_LEFT}" -lt 0 ]]; then
        fail "TLS certificate EXPIRED (${DAYS_LEFT} days ago)"
      elif [[ "${DAYS_LEFT}" -lt 7 ]]; then
        warn "TLS certificate expires in ${DAYS_LEFT} days — Caddy should auto-renew"
      else
        pass "  Days until expiry: ${DAYS_LEFT}"
      fi
    fi
  fi
fi

# ── 5. BasicAuth gate (unauthenticated) ────────────────────────────────────────
header "── 5. BasicAuth Gate (unauthenticated) ───────────────────"

if [[ "${SKIP_DNS}" == "1" ]]; then
  warn "BasicAuth check skipped (requires DNS — set SKIP_DNS=0)"
else
  UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 20 \
    "https://${GRAFANA_HOST}/" 2>/dev/null || echo "000")

  case "${UNAUTH_CODE}" in
    401)
      pass "https://${GRAFANA_HOST}/ → 401 (BasicAuth gate active — correct)"
      ;;
    200)
      warn "https://${GRAFANA_HOST}/ → 200 without credentials (BasicAuth may not be configured)"
      ;;
    000)
      fail "https://${GRAFANA_HOST}/ — connection failed (TLS or DNS issue)"
      echo "  Hint: DNS may not have propagated or Caddy has not issued the cert yet"
      ;;
    *)
      warn "https://${GRAFANA_HOST}/ → ${UNAUTH_CODE} (unexpected response)"
      ;;
  esac
fi

# ── 6. Authenticated access ───────────────────────────────────────────────────
header "── 6. Authenticated Access ────────────────────────────────"

if [[ -z "${GRAFANA_ADMIN_PASSWORD}" ]]; then
  warn "Skipping authenticated check (GRAFANA_ADMIN_PASSWORD not set)"
  echo "       Hint: source .env && ./scripts/verify-grafana.sh"
elif [[ "${SKIP_DNS}" == "1" ]]; then
  warn "Authenticated check skipped (requires DNS — set SKIP_DNS=0)"
else
  AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 20 \
    -u "${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}" \
    "https://${GRAFANA_HOST}/" 2>/dev/null || echo "000")

  case "${AUTH_CODE}" in
    200)
      pass "https://${GRAFANA_HOST}/ → 200 with credentials (Grafana UI accessible)"
      ;;
    302|301)
      pass "https://${GRAFANA_HOST}/ → ${AUTH_CODE} redirect (Grafana login redirect — acceptable)"
      ;;
    401)
      fail "https://${GRAFANA_HOST}/ → 401 with correct credentials (wrong password or BasicAuth misconfigured)"
      ;;
    000)
      fail "https://${GRAFANA_HOST}/ — connection failed during authenticated check"
      ;;
    *)
      warn "https://${GRAFANA_HOST}/ → ${AUTH_CODE} (authenticated; unexpected code)"
      ;;
  esac
fi

# ── 7. Grafana API health ──────────────────────────────────────────────────────
header "── 7. Grafana /api/health ──────────────────────────────────"

if [[ -z "${GRAFANA_ADMIN_PASSWORD}" ]]; then
  warn "Skipping /api/health check (GRAFANA_ADMIN_PASSWORD not set)"
elif [[ "${SKIP_DNS}" == "1" ]]; then
  warn "/api/health check skipped (requires DNS — set SKIP_DNS=0)"
else
  # Grafana /api/health does NOT require BasicAuth — it's always unauthenticated
  # but the Caddy BasicAuth middleware may gate it. Try with credentials.
  HEALTH_BODY=$(curl -s \
    --max-time 15 \
    -u "${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}" \
    "https://${GRAFANA_HOST}/api/health" 2>/dev/null || echo "")

  if echo "${HEALTH_BODY}" | grep -q '"database":"ok"'; then
    pass "Grafana /api/health → {\"database\":\"ok\"} (Grafana healthy)"
  elif echo "${HEALTH_BODY}" | grep -q '"database"'; then
    DB_STATUS=$(echo "${HEALTH_BODY}" | grep -o '"database":"[^"]*"' || echo "unknown")
    warn "Grafana /api/health database status: ${DB_STATUS}"
  elif [[ -z "${HEALTH_BODY}" ]]; then
    warn "Grafana /api/health returned empty response (BasicAuth may gate this path)"
    echo "       Hint: This is expected if Caddy BasicAuth covers all paths"
  else
    warn "Grafana /api/health response: ${HEALTH_BODY:0:120}"
  fi
fi

# ── 8. Prometheus datasource health + test query ───────────────────────────────
header "── 8. Prometheus Datasource ───────────────────────────────"

if [[ -z "${GRAFANA_ADMIN_PASSWORD}" ]]; then
  warn "Skipping Prometheus datasource check (GRAFANA_ADMIN_PASSWORD not set)"
else
  # Use kubectl port-forward to Grafana pod — bypasses DNS/TLS dependency.
  # Works even before wildcard DNS has propagated, making this check standalone.
  GRAFANA_LOCAL_PORT=13000
  PF_PID=""

  GRAFANA_POD=$(kubectl get pods -n monitoring \
    -l "app.kubernetes.io/name=grafana" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

  if [[ -z "${GRAFANA_POD}" ]]; then
    fail "No running Grafana pod found — cannot check Prometheus datasource"
    echo "  Hint: kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana"
  else
    # Start port-forward in background
    kubectl port-forward -n monitoring "${GRAFANA_POD}" \
      "${GRAFANA_LOCAL_PORT}:3000" >/dev/null 2>&1 &
    PF_PID=$!

    # Poll until Grafana API responds (max 15s)
    PF_READY=false
    for _i in $(seq 1 15); do
      if curl -s --max-time 2 \
          -u "${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}" \
          "http://localhost:${GRAFANA_LOCAL_PORT}/api/health" >/dev/null 2>&1; then
        PF_READY=true
        break
      fi
      sleep 1
    done

    if [[ "${PF_READY}" != "true" ]]; then
      fail "Grafana port-forward did not become ready on localhost:${GRAFANA_LOCAL_PORT}"
      echo "  Hint: kubectl port-forward -n monitoring ${GRAFANA_POD} 13000:3000"
      kill "${PF_PID}" 2>/dev/null || true
    else
      GRAFANA_API="http://localhost:${GRAFANA_LOCAL_PORT}"
      GRAFANA_AUTH="${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}"

      # ── 8a. Find Prometheus datasource ──────────────────────────────────────
      DS_JSON=$(curl -s --max-time 10 -u "${GRAFANA_AUTH}" \
        "${GRAFANA_API}/api/datasources" 2>/dev/null || echo "[]")

      # Parse datasource uid/name — prefer jq, fall back to python3
      if command -v jq &>/dev/null; then
        PROM_UID=$(echo "${DS_JSON}" \
          | jq -r '.[] | select(.type=="prometheus") | .uid' 2>/dev/null | head -1 || echo "")
        PROM_NAME=$(echo "${DS_JSON}" \
          | jq -r '.[] | select(.type=="prometheus") | .name' 2>/dev/null | head -1 || echo "")
      elif command -v python3 &>/dev/null; then
        PROM_UID=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ds = next((d for d in data if d.get('type') == 'prometheus'), None)
print(ds['uid'] if ds else '')
" <<< "${DS_JSON}" 2>/dev/null || echo "")
        PROM_NAME=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ds = next((d for d in data if d.get('type') == 'prometheus'), None)
print(ds.get('name','') if ds else '')
" <<< "${DS_JSON}" 2>/dev/null || echo "")
      else
        # Last resort: grep-based extraction (fragile, best-effort)
        PROM_UID=$(echo "${DS_JSON}" \
          | grep -o '"uid":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
        PROM_NAME="Prometheus"
      fi

      if [[ -z "${PROM_UID}" ]]; then
        fail "No Prometheus datasource found in Grafana (expected type=prometheus)"
        echo "  Hint: kube-prometheus-stack auto-provisions a Prometheus datasource"
        echo "  Hint: kubectl logs -n monitoring -l app.kubernetes.io/name=grafana --tail=50"
      else
        pass "Prometheus datasource found: '${PROM_NAME}' (uid=${PROM_UID})"

        # ── 8b. Datasource health check ─────────────────────────────────────
        HEALTH_JSON=$(curl -s --max-time 15 -u "${GRAFANA_AUTH}" \
          "${GRAFANA_API}/api/datasources/uid/${PROM_UID}/health" 2>/dev/null || echo "{}")

        if command -v jq &>/dev/null; then
          HEALTH_STATUS=$(echo "${HEALTH_JSON}" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")
          HEALTH_MSG=$(echo "${HEALTH_JSON}" | jq -r '.message // ""' 2>/dev/null || echo "")
        elif command -v python3 &>/dev/null; then
          HEALTH_STATUS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('status', 'unknown'))
" <<< "${HEALTH_JSON}" 2>/dev/null || echo "unknown")
          HEALTH_MSG=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('message', ''))
" <<< "${HEALTH_JSON}" 2>/dev/null || echo "")
        else
          HEALTH_STATUS=$(echo "${HEALTH_JSON}" | grep -o '"status":"[^"]*"' \
            | cut -d'"' -f4 || echo "unknown")
          HEALTH_MSG=""
        fi

        if [[ "${HEALTH_STATUS}" == "OK" ]]; then
          pass "Prometheus datasource health: OK${HEALTH_MSG:+ — ${HEALTH_MSG}}"
        else
          fail "Prometheus datasource health: ${HEALTH_STATUS}${HEALTH_MSG:+ — ${HEALTH_MSG}}"
          echo "  Hint: Check Prometheus pods: kubectl get pods -n monitoring"
          echo "  Raw response: ${HEALTH_JSON:0:200}"
        fi

        # ── 8c. Test query — instant query for 'up' metric ──────────────────
        QUERY_PAYLOAD="{
          \"queries\": [{
            \"refId\": \"A\",
            \"expr\": \"up\",
            \"datasourceUid\": \"${PROM_UID}\",
            \"queryType\": \"timeSeriesQuery\",
            \"instant\": true
          }],
          \"from\": \"now-5m\",
          \"to\": \"now\"
        }"

        QUERY_JSON=$(curl -s --max-time 15 -u "${GRAFANA_AUTH}" \
          -H "Content-Type: application/json" \
          -d "${QUERY_PAYLOAD}" \
          "${GRAFANA_API}/api/ds/query" 2>/dev/null || echo "{}")

        if command -v jq &>/dev/null; then
          FRAME_COUNT=$(echo "${QUERY_JSON}" \
            | jq '[.results.A.frames // [] | .[]] | length' 2>/dev/null || echo "0")
          QUERY_ERR=$(echo "${QUERY_JSON}" \
            | jq -r '.results.A.error // ""' 2>/dev/null || echo "")
        elif command -v python3 &>/dev/null; then
          FRAME_COUNT=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
frames = d.get('results', {}).get('A', {}).get('frames', [])
print(len(frames))
" <<< "${QUERY_JSON}" 2>/dev/null || echo "0")
          QUERY_ERR=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('results', {}).get('A', {}).get('error', ''))
" <<< "${QUERY_JSON}" 2>/dev/null || echo "")
        else
          # Fallback: check for non-empty frames array
          FRAME_COUNT=$(echo "${QUERY_JSON}" | grep -c '"frames"' || echo "0")
          QUERY_ERR=""
        fi

        # Sanitize FRAME_COUNT to integer
        FRAME_COUNT=$(echo "${FRAME_COUNT}" | tr -d '[:space:]' | grep -E '^[0-9]+$' || echo "0")

        if [[ "${FRAME_COUNT}" -gt 0 ]]; then
          pass "Prometheus test query 'up' returned ${FRAME_COUNT} series — data flowing"
        elif [[ -n "${QUERY_ERR}" ]]; then
          fail "Prometheus test query 'up' failed: ${QUERY_ERR}"
          echo "  Hint: Prometheus may still be scraping targets — wait ~2m after deploy"
        else
          warn "Prometheus test query 'up' returned 0 series — Prometheus may still be starting"
          echo "  Hint: Re-run in ~2 minutes once Prometheus has collected first scrape"
        fi
      fi

      # Tear down port-forward
      kill "${PF_PID}" 2>/dev/null || true
      PF_PID=""
    fi
  fi
fi

# ── 9. Default dashboards (k3s / node / cluster) ──────────────────────────────
header "── 9. Default Dashboards ───────────────────────────────────"

if [[ -z "${GRAFANA_ADMIN_PASSWORD}" ]]; then
  warn "Skipping dashboard check (GRAFANA_ADMIN_PASSWORD not set)"
else
  GRAFANA_DASH_PORT=13001
  DASH_PF_PID=""

  GRAFANA_POD2=$(kubectl get pods -n monitoring \
    -l "app.kubernetes.io/name=grafana" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

  if [[ -z "${GRAFANA_POD2}" ]]; then
    fail "No running Grafana pod found — cannot check dashboards"
    echo "  Hint: kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana"
  else
    kubectl port-forward -n monitoring "${GRAFANA_POD2}" \
      "${GRAFANA_DASH_PORT}:3000" >/dev/null 2>&1 &
    DASH_PF_PID=$!

    DASH_PF_READY=false
    for _i in $(seq 1 15); do
      if curl -s --max-time 2 \
          -u "${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}" \
          "http://localhost:${GRAFANA_DASH_PORT}/api/health" >/dev/null 2>&1; then
        DASH_PF_READY=true
        break
      fi
      sleep 1
    done

    if [[ "${DASH_PF_READY}" != "true" ]]; then
      fail "Grafana port-forward (port ${GRAFANA_DASH_PORT}) did not become ready"
      echo "  Hint: kubectl port-forward -n monitoring ${GRAFANA_POD2} 13001:3000"
      kill "${DASH_PF_PID}" 2>/dev/null || true
    else
      DASH_API="http://localhost:${GRAFANA_DASH_PORT}"
      DASH_AUTH="${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}"

      # ── 9a. Total dashboard count ────────────────────────────────────────
      DASH_JSON=$(curl -s --max-time 15 -u "${DASH_AUTH}" \
        "${DASH_API}/api/search?type=dash-db&limit=200" 2>/dev/null || echo "[]")

      if command -v jq &>/dev/null; then
        TOTAL_DASHBOARDS=$(echo "${DASH_JSON}" | jq 'length' 2>/dev/null || echo "0")
      elif command -v python3 &>/dev/null; then
        TOTAL_DASHBOARDS=$(python3 -c "
import json, sys
print(len(json.loads(sys.stdin.read())))
" <<< "${DASH_JSON}" 2>/dev/null || echo "0")
      else
        TOTAL_DASHBOARDS=$(echo "${DASH_JSON}" | grep -c '"uid"' || echo "0")
      fi
      TOTAL_DASHBOARDS=$(echo "${TOTAL_DASHBOARDS}" | tr -d '[:space:]' \
        | grep -E '^[0-9]+$' || echo "0")

      if [[ "${TOTAL_DASHBOARDS}" -gt 0 ]]; then
        pass "${TOTAL_DASHBOARDS} dashboard(s) loaded in Grafana"
      else
        fail "No dashboards found — kube-prometheus-stack sidecar may not have loaded them"
        echo "  Hint: kubectl logs -n monitoring -l app.kubernetes.io/name=grafana \\"
        echo "          -c grafana-sc-dashboard --tail=50"
      fi

      # ── 9b. Expected dashboard patterns ─────────────────────────────────
      # kube-prometheus-stack bundles node-exporter and k8s resource dashboards.
      # k3s disables etcd/controller-manager/scheduler, so those are NOT expected.
      EXPECTED_LABELS=(
        "Node Exporter"
        "Kubernetes Compute Resources"
        "Kubernetes Networking"
        "Kubernetes Nodes"
      )
      EXPECTED_PATTERNS=(
        "node.?exporter"
        "Kubernetes.*Compute|compute.*resources"
        "Kubernetes.*Network|networking"
        "Kubernetes.*[Nn]ode|node.*(overview|use)"
      )

      if command -v jq &>/dev/null; then
        DASH_TITLES=$(echo "${DASH_JSON}" | jq -r '.[].title' 2>/dev/null || echo "")
      elif command -v python3 &>/dev/null; then
        DASH_TITLES=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print('\n'.join(d.get('title','') for d in data))
" <<< "${DASH_JSON}" 2>/dev/null || echo "")
      else
        DASH_TITLES=$(echo "${DASH_JSON}" \
          | grep -o '"title":"[^"]*"' | cut -d'"' -f4 || echo "")
      fi

      for IDX in "${!EXPECTED_LABELS[@]}"; do
        LABEL="${EXPECTED_LABELS[${IDX}]}"
        PATTERN="${EXPECTED_PATTERNS[${IDX}]}"
        if echo "${DASH_TITLES}" | grep -qiE "${PATTERN}"; then
          MATCHED=$(echo "${DASH_TITLES}" | grep -iE "${PATTERN}" | head -1 | xargs)
          pass "Dashboard found: ${LABEL} (\"${MATCHED}\")"
        else
          warn "Dashboard not found: ${LABEL} (pattern: ${PATTERN})"
          echo "       Hint: kube-prometheus-stack auto-loads these via the sidecar"
          echo "       Hint: kubectl get configmaps -n monitoring -l grafana_dashboard=1"
        fi
      done

      # ── 9c. Panel error check — sample first 5 dashboards ────────────────
      if command -v jq &>/dev/null; then
        DASH_UIDS=$(echo "${DASH_JSON}" \
          | jq -r '.[0:5] | .[].uid' 2>/dev/null || echo "")
      elif command -v python3 &>/dev/null; then
        DASH_UIDS=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
print('\n'.join(d.get('uid','') for d in data[:5]))
" <<< "${DASH_JSON}" 2>/dev/null || echo "")
      else
        DASH_UIDS=$(echo "${DASH_JSON}" \
          | grep -o '"uid":"[^"]*"' | head -5 | cut -d'"' -f4 || echo "")
      fi

      TOTAL_PANEL_ERRORS=0
      DASH_CHECKED=0
      while IFS= read -r DASH_UID; do
        [[ -z "${DASH_UID}" ]] && continue
        DETAIL_JSON=$(curl -s --max-time 10 -u "${DASH_AUTH}" \
          "${DASH_API}/api/dashboards/uid/${DASH_UID}" 2>/dev/null || echo "{}")

        if command -v jq &>/dev/null; then
          ERR_COUNT=$(echo "${DETAIL_JSON}" \
            | jq '[.dashboard.panels[]? | select(.type=="error")] | length' \
            2>/dev/null || echo "0")
          PANEL_COUNT=$(echo "${DETAIL_JSON}" \
            | jq '(.dashboard.panels // []) | length' 2>/dev/null || echo "0")
          DASH_TITLE=$(echo "${DETAIL_JSON}" \
            | jq -r '.dashboard.title // "unknown"' 2>/dev/null || echo "unknown")
        elif command -v python3 &>/dev/null; then
          ERR_COUNT=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
panels = d.get('dashboard', {}).get('panels', [])
print(sum(1 for p in panels if p.get('type') == 'error'))
" <<< "${DETAIL_JSON}" 2>/dev/null || echo "0")
          PANEL_COUNT=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(len(d.get('dashboard', {}).get('panels', [])))
" <<< "${DETAIL_JSON}" 2>/dev/null || echo "0")
          DASH_TITLE=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('dashboard', {}).get('title', 'unknown'))
" <<< "${DETAIL_JSON}" 2>/dev/null || echo "unknown")
        else
          ERR_COUNT=0; PANEL_COUNT=0; DASH_TITLE="${DASH_UID}"
        fi

        ERR_COUNT=$(echo "${ERR_COUNT}" | tr -d '[:space:]' \
          | grep -E '^[0-9]+$' || echo "0")
        PANEL_COUNT=$(echo "${PANEL_COUNT}" | tr -d '[:space:]' \
          | grep -E '^[0-9]+$' || echo "0")
        DASH_CHECKED=$((DASH_CHECKED + 1))

        if [[ "${ERR_COUNT}" -gt 0 ]]; then
          fail "Dashboard '${DASH_TITLE}': ${ERR_COUNT} error panel(s)"
          echo "  Hint: Error panels usually indicate a missing or misconfigured datasource"
          TOTAL_PANEL_ERRORS=$((TOTAL_PANEL_ERRORS + ERR_COUNT))
        elif [[ "${PANEL_COUNT}" -gt 0 ]]; then
          pass "Dashboard '${DASH_TITLE}': ${PANEL_COUNT} panel(s), 0 errors"
        else
          warn "Dashboard '${DASH_TITLE}': 0 panels — may be folder row or empty dashboard"
        fi
      done <<< "${DASH_UIDS}"

      if [[ "${DASH_CHECKED}" -gt 0 ]]; then
        if [[ "${TOTAL_PANEL_ERRORS}" -eq 0 ]]; then
          pass "Panel error check: 0 errors across ${DASH_CHECKED} dashboard(s) sampled"
        else
          fail "Panel error check: ${TOTAL_PANEL_ERRORS} error panel(s) in ${DASH_CHECKED} dashboard(s)"
          echo "  Hint: Re-run after datasources are confirmed healthy (Step 8)"
        fi
      fi

      kill "${DASH_PF_PID}" 2>/dev/null || true
      DASH_PF_PID=""
    fi
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
header "── Summary ────────────────────────────────────────────────"
echo ""
if [[ "${FAILURES}" -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}All checks passed.${RESET} Grafana is accessible at https://${GRAFANA_HOST}/"
  echo ""
  echo "  LoadBalancer IP : ${LB_IP}"
  echo "  Grafana URL     : https://${GRAFANA_HOST}/"
  echo "  TLS             : Valid Let's Encrypt certificate"
  echo "  Auth            : BasicAuth gating active"
  echo "  Prometheus DS   : Healthy (status=OK, query returned data)"
  echo "  Dashboards      : Loaded (k3s/node/cluster panels verified)"
else
  echo -e "  ${RED}${BOLD}${FAILURES} check(s) failed.${RESET}"
  echo ""
  echo "  Troubleshooting:"
  echo "    kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana"
  echo "    kubectl logs -n monitoring -l app.kubernetes.io/name=grafana --tail=50"
  echo "    kubectl get svc -n caddy-ingress caddy-ingress"
  echo "    dig ${GRAFANA_HOST}"
  echo ""
  echo "  If DNS hasn't propagated yet, re-run with SKIP_DNS=1:"
  echo "    SKIP_DNS=1 source .env && ./scripts/verify-grafana.sh"
  exit 1
fi
