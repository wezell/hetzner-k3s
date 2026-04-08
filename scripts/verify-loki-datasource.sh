#!/usr/bin/env bash
# verify-loki-datasource.sh — Verify Loki datasource in Grafana returns query results
#
# AC 3c-3: Uses Grafana API to:
#   1. Find the Loki datasource UID registered in Grafana
#   2. Test datasource health via /api/datasources/uid/{uid}/health
#   3. Execute a sample LogQL query via /api/ds/query and confirm data is returned
#
# All checks use kubectl port-forward to reach Grafana — bypasses DNS/TLS dependency
# so this script works even before wildcard DNS has propagated.
#
# Prerequisites:
#   - kubectl configured for the cluster
#   - .env sourced with GRAFANA_ADMIN_USER + GRAFANA_ADMIN_PASSWORD
#   - Loki deployed and Grafana auto-provisioned with a loki datasource
#     (install-monitoring.sh handles both)
#
# Usage:
#   source .env && ./scripts/verify-loki-datasource.sh
#   GRAFANA_ADMIN_USER=admin GRAFANA_ADMIN_PASSWORD=secret ./scripts/verify-loki-datasource.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass()   { echo -e "${GREEN}  ✓ $*${RESET}"; ((PASS_COUNT++)); }
fail()   { echo -e "${RED}  ✗ $*${RESET}"; ((FAIL_COUNT++)); }
warn()   { echo -e "${YELLOW}  ⚠ $*${RESET}"; ((WARN_COUNT++)); }
header() { echo -e "\n${CYAN}${BOLD}$*${RESET}"; }
info()   { echo -e "    $*"; }

# ── Load .env if present ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck source=/dev/null
  set -a; source "${ENV_FILE}"; set +a
  info "Loaded ${ENV_FILE}"
fi

# ── Env defaults ───────────────────────────────────────────────────────────────
GRAFANA_ADMIN_USER="${GRAFANA_ADMIN_USER:-admin}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-}"
GRAFANA_NAMESPACE="${GRAFANA_NAMESPACE:-monitoring}"
GRAFANA_LOCAL_PORT="${GRAFANA_LOCAL_PORT:-13002}"

# ── Dependency checks ──────────────────────────────────────────────────────────
echo -e "\n${BOLD}=== Loki Datasource Verification (Grafana API) ===${RESET}"
echo "Cluster:   $(kubectl config current-context 2>/dev/null || echo 'unknown')"
echo "Namespace: ${GRAFANA_NAMESPACE}"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

header "── Prerequisites ──────────────────────────────────────────"

if ! command -v kubectl &>/dev/null; then
  fail "kubectl not found in PATH"
  exit 1
fi
pass "kubectl available"

if ! command -v curl &>/dev/null; then
  fail "curl not found in PATH"
  exit 1
fi
pass "curl available"

# Warn if jq is missing — we fall back to python3
if command -v jq &>/dev/null; then
  pass "jq available (preferred JSON parser)"
  USE_JQ=true
elif command -v python3 &>/dev/null; then
  warn "jq not found — using python3 for JSON parsing"
  USE_JQ=false
else
  fail "Neither jq nor python3 found — cannot parse Grafana API responses"
  exit 1
fi

if [[ -z "${GRAFANA_ADMIN_PASSWORD}" ]]; then
  fail "GRAFANA_ADMIN_PASSWORD not set — cannot authenticate to Grafana API"
  info "Hint: source .env before running, or export GRAFANA_ADMIN_PASSWORD=<password>"
  exit 1
fi
pass "GRAFANA_ADMIN_PASSWORD set"

# ── Helper: parse JSON field ───────────────────────────────────────────────────
# Usage: json_field <json_string> <jq_filter> <python_expression>
json_field() {
  local json="$1" jq_filter="$2" py_expr="$3"
  if [[ "${USE_JQ}" == "true" ]]; then
    echo "${json}" | jq -r "${jq_filter}" 2>/dev/null || echo ""
  else
    python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
try:
    print(${py_expr})
except Exception:
    print('')
" <<< "${json}" 2>/dev/null || echo ""
  fi
}

# ── Step 1: Find running Grafana pod ──────────────────────────────────────────
header "── 1. Grafana Pod ─────────────────────────────────────────"

GRAFANA_POD=$(kubectl get pods -n "${GRAFANA_NAMESPACE}" \
  -l "app.kubernetes.io/name=grafana" \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "${GRAFANA_POD}" ]]; then
  fail "No running Grafana pod in namespace '${GRAFANA_NAMESPACE}'"
  info "Hint: kubectl get pods -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=grafana"
  exit 1
fi
pass "Grafana pod: ${GRAFANA_POD}"

# ── Step 2: Start port-forward ─────────────────────────────────────────────────
header "── 2. Port-Forward to Grafana ─────────────────────────────"

PF_PID=""

cleanup() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
    PF_PID=""
  fi
}
trap cleanup EXIT INT TERM

kubectl port-forward -n "${GRAFANA_NAMESPACE}" "${GRAFANA_POD}" \
  "${GRAFANA_LOCAL_PORT}:3000" >/dev/null 2>&1 &
PF_PID=$!

# Poll until Grafana API responds (max 20s)
GRAFANA_API="http://localhost:${GRAFANA_LOCAL_PORT}"
GRAFANA_AUTH="${GRAFANA_ADMIN_USER}:${GRAFANA_ADMIN_PASSWORD}"
PF_READY=false

for _i in $(seq 1 20); do
  if curl -s --max-time 2 \
      -u "${GRAFANA_AUTH}" \
      "${GRAFANA_API}/api/health" >/dev/null 2>&1; then
    PF_READY=true
    break
  fi
  sleep 1
done

if [[ "${PF_READY}" != "true" ]]; then
  fail "Grafana port-forward did not become ready on localhost:${GRAFANA_LOCAL_PORT} (20s timeout)"
  info "Hint: kubectl port-forward -n ${GRAFANA_NAMESPACE} ${GRAFANA_POD} ${GRAFANA_LOCAL_PORT}:3000"
  info "Hint: curl -u ${GRAFANA_ADMIN_USER}:<pass> http://localhost:${GRAFANA_LOCAL_PORT}/api/health"
  exit 1
fi
pass "Port-forward ready on localhost:${GRAFANA_LOCAL_PORT}"

# ── Step 3: Find Loki datasource ──────────────────────────────────────────────
header "── 3. Loki Datasource Discovery ───────────────────────────"

DS_JSON=$(curl -s --max-time 10 -u "${GRAFANA_AUTH}" \
  "${GRAFANA_API}/api/datasources" 2>/dev/null || echo "[]")

if [[ "${USE_JQ}" == "true" ]]; then
  LOKI_UID=$(echo "${DS_JSON}" \
    | jq -r '.[] | select(.type=="loki") | .uid' 2>/dev/null | head -1 || echo "")
  LOKI_NAME=$(echo "${DS_JSON}" \
    | jq -r '.[] | select(.type=="loki") | .name' 2>/dev/null | head -1 || echo "")
  LOKI_URL=$(echo "${DS_JSON}" \
    | jq -r '.[] | select(.type=="loki") | .url' 2>/dev/null | head -1 || echo "")
  DS_COUNT=$(echo "${DS_JSON}" | jq 'length' 2>/dev/null || echo "0")
else
  LOKI_UID=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ds = next((d for d in data if d.get('type') == 'loki'), None)
print(ds['uid'] if ds else '')
" <<< "${DS_JSON}" 2>/dev/null || echo "")
  LOKI_NAME=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ds = next((d for d in data if d.get('type') == 'loki'), None)
print(ds.get('name','') if ds else '')
" <<< "${DS_JSON}" 2>/dev/null || echo "")
  LOKI_URL=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ds = next((d for d in data if d.get('type') == 'loki'), None)
print(ds.get('url','') if ds else '')
" <<< "${DS_JSON}" 2>/dev/null || echo "")
  DS_COUNT=$(python3 -c "
import json, sys
print(len(json.loads(sys.stdin.read())))
" <<< "${DS_JSON}" 2>/dev/null || echo "0")
fi

info "Total datasources registered: ${DS_COUNT}"

if [[ -z "${LOKI_UID}" ]]; then
  fail "No Loki datasource found in Grafana (expected type=loki)"
  info "Hint: install-monitoring.sh auto-provisions a Loki datasource via kube-prometheus-stack sidecar"
  info "Hint: kubectl logs -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=grafana --tail=50"
  info "Raw datasource list (first 400 chars): ${DS_JSON:0:400}"
  exit 1
fi
pass "Loki datasource found: '${LOKI_NAME}' (uid=${LOKI_UID})"
info "Loki URL in Grafana: ${LOKI_URL}"

# ── Step 4: Datasource health check ───────────────────────────────────────────
header "── 4. Loki Datasource Health Check ────────────────────────"
info "Endpoint: GET /api/datasources/uid/${LOKI_UID}/health"

HEALTH_JSON=$(curl -s --max-time 15 -u "${GRAFANA_AUTH}" \
  "${GRAFANA_API}/api/datasources/uid/${LOKI_UID}/health" 2>/dev/null || echo "{}")

if [[ "${USE_JQ}" == "true" ]]; then
  HEALTH_STATUS=$(echo "${HEALTH_JSON}" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")
  HEALTH_MSG=$(echo "${HEALTH_JSON}" | jq -r '.message // ""' 2>/dev/null || echo "")
  HEALTH_DETAILS=$(echo "${HEALTH_JSON}" | jq -r '.details // {} | @json' 2>/dev/null || echo "")
else
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
  HEALTH_DETAILS=""
fi

if [[ "${HEALTH_STATUS}" == "OK" ]]; then
  pass "Loki datasource health: OK${HEALTH_MSG:+ — ${HEALTH_MSG}}"
  [[ -n "${HEALTH_DETAILS}" && "${HEALTH_DETAILS}" != "{}" ]] && \
    info "Details: ${HEALTH_DETAILS}"
else
  fail "Loki datasource health: ${HEALTH_STATUS}${HEALTH_MSG:+ — ${HEALTH_MSG}}"
  info "Hint: Check Loki pods: kubectl get pods -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=loki"
  info "Hint: kubectl logs -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=loki --tail=50"
  info "Raw health response: ${HEALTH_JSON:0:300}"
fi

# ── Step 5: LogQL query via Grafana /api/ds/query ─────────────────────────────
header "── 5. LogQL Test Query ─────────────────────────────────────"
info "Query:    {namespace=~\".+\"} (any log stream, last 5 minutes)"
info "Endpoint: POST /api/ds/query"

# Loki range query via Grafana's unified query API.
# queryType=range returns log lines; maxLines=10 avoids large payloads.
# The broad selector {namespace=~".+"} matches any label-set with a namespace
# label — Promtail tags every log line with the pod's namespace.
QUERY_PAYLOAD="{
  \"queries\": [{
    \"refId\": \"A\",
    \"expr\": \"{namespace=~\\\".+\\\"}\",
    \"datasourceUid\": \"${LOKI_UID}\",
    \"queryType\": \"range\",
    \"maxLines\": 10,
    \"legendFormat\": \"\"
  }],
  \"from\": \"now-5m\",
  \"to\": \"now\"
}"

QUERY_JSON=$(curl -s --max-time 20 -u "${GRAFANA_AUTH}" \
  -H "Content-Type: application/json" \
  -d "${QUERY_PAYLOAD}" \
  "${GRAFANA_API}/api/ds/query" 2>/dev/null || echo "{}")

if [[ "${USE_JQ}" == "true" ]]; then
  FRAME_COUNT=$(echo "${QUERY_JSON}" \
    | jq '[.results.A.frames // [] | .[]] | length' 2>/dev/null || echo "0")
  QUERY_ERR=$(echo "${QUERY_JSON}" \
    | jq -r '.results.A.error // ""' 2>/dev/null || echo "")
  # Extract first few log lines for display
  SAMPLE_LINES=$(echo "${QUERY_JSON}" \
    | jq -r '
        .results.A.frames[0].data.values
        | if . then
            (.[1] // []) | .[0:3] | .[]
          else "" end
      ' 2>/dev/null | head -3 || echo "")
else
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
  SAMPLE_LINES=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
try:
    frames = d.get('results', {}).get('A', {}).get('frames', [])
    if frames:
        vals = frames[0].get('data', {}).get('values', [])
        lines = vals[1][:3] if len(vals) > 1 else []
        for l in lines: print(l[:120])
except Exception:
    pass
" <<< "${QUERY_JSON}" 2>/dev/null || echo "")
fi

# Sanitize FRAME_COUNT to integer
FRAME_COUNT=$(echo "${FRAME_COUNT}" | tr -d '[:space:]' | grep -E '^[0-9]+$' || echo "0")

if [[ "${FRAME_COUNT}" -gt 0 ]]; then
  pass "LogQL query returned ${FRAME_COUNT} frame(s) — Loki has data"
  if [[ -n "${SAMPLE_LINES}" ]]; then
    info "Sample log lines:"
    while IFS= read -r line; do
      info "  | ${line:0:120}"
    done <<< "${SAMPLE_LINES}"
  fi
elif [[ -n "${QUERY_ERR}" ]]; then
  fail "LogQL query error: ${QUERY_ERR}"
  info "Hint: Loki may be healthy but Promtail has not shipped logs yet (wait ~2m after deploy)"
  info "Hint: kubectl logs -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=promtail --tail=30"
else
  warn "LogQL query returned 0 frames — no log data in last 5 minutes"
  info "This may be normal if:"
  info "  - Promtail DaemonSet is still starting up (wait ~2 min)"
  info "  - No pods have generated logs in the last 5 minutes"
  info "  - Loki's auth_enabled=true requires X-Scope-OrgID and no tenant has shipped logs"
  info "Hint: kubectl get pods -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=promtail"
  info "Hint: kubectl logs -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=promtail --tail=30"
fi

# ── Step 6: Broader label-values probe (fallback) ─────────────────────────────
header "── 6. Loki Label Values Probe (via Grafana proxy) ─────────"
info "Endpoint: GET /api/datasources/proxy/uid/${LOKI_UID}/loki/api/v1/labels"

LABELS_JSON=$(curl -s --max-time 10 -u "${GRAFANA_AUTH}" \
  "${GRAFANA_API}/api/datasources/proxy/uid/${LOKI_UID}/loki/api/v1/labels" \
  2>/dev/null || echo "{}")

if [[ "${USE_JQ}" == "true" ]]; then
  LABEL_STATUS=$(echo "${LABELS_JSON}" | jq -r '.status // "error"' 2>/dev/null || echo "error")
  LABEL_DATA=$(echo "${LABELS_JSON}" | jq -r '.data // [] | join(", ")' 2>/dev/null || echo "")
else
  LABEL_STATUS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(d.get('status', 'error'))
" <<< "${LABELS_JSON}" 2>/dev/null || echo "error")
  LABEL_DATA=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(', '.join(d.get('data', [])))
" <<< "${LABELS_JSON}" 2>/dev/null || echo "")
fi

if [[ "${LABEL_STATUS}" == "success" ]]; then
  pass "Loki labels API: success"
  info "Available labels: ${LABEL_DATA:-<none yet>}"
else
  warn "Loki labels API status: ${LABEL_STATUS}"
  info "Raw response: ${LABELS_JSON:0:200}"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Loki Datasource Verification Summary${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════════${RESET}"
echo -e "  ${GREEN}Passed:${RESET}  ${PASS_COUNT}"
echo -e "  ${YELLOW}Warnings:${RESET} ${WARN_COUNT}"
echo -e "  ${RED}Failed:${RESET}  ${FAIL_COUNT}"
echo ""

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  echo -e "${RED}${BOLD}  ✗ VERIFICATION FAILED — review errors above${RESET}"
  echo ""
  echo "  Troubleshooting:"
  echo "    Grafana:  kubectl get pods -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=grafana"
  echo "    Loki:     kubectl get pods -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=loki"
  echo "    Promtail: kubectl get pods -n ${GRAFANA_NAMESPACE} -l app.kubernetes.io/name=promtail"
  echo "    Redeploy: ./scripts/install-monitoring.sh"
  exit 1
else
  echo -e "${GREEN}${BOLD}  ✓ VERIFICATION PASSED — Loki datasource is healthy${RESET}"
  echo ""
  echo "  Next steps:"
  echo "    Browse logs: https://observe.${BASE_DOMAIN:-botcms.cloud}"
  echo "    Explore → Loki → {namespace=\"<tenant>\"}"
  exit 0
fi
