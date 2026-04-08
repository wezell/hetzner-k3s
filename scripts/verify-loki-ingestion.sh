#!/usr/bin/env bash
# scripts/verify-loki-ingestion.sh — Verify Loki is ingesting logs from tenant namespaces
#
# Queries the live Loki API via kubectl port-forward to confirm that log streams
# exist for tenant namespaces (labelled botcms.cloud/tenant=<name>).
#
# Architecture:
#   • Loki SingleBinary deployed in 'monitoring' namespace via grafana/loki chart
#   • Multi-tenancy enabled (auth_enabled: true); each request requires X-Scope-OrgID
#   • Promtail sets X-Scope-OrgID = Kubernetes namespace name for log isolation
#   • Port-forward targets svc/loki-gateway (nginx proxy) on port 80
#
# Verification flow:
#   1. Start kubectl port-forward to svc/loki-gateway
#   2. Discover tenant namespaces (label: botcms.cloud/tenant)
#   3. For each tenant namespace, query Loki labels API (X-Scope-OrgID = namespace)
#   4. Confirm at least one stream with {namespace="<ns>"} label exists
#   5. Report per-tenant stream counts and sample log line
#
# If no tenant namespaces exist, falls back to checking Promtail's own namespace
# ('monitoring') to verify basic Loki ingest pipeline is operational.
#
# Usage (standalone):
#   KUBECONFIG=./kubeconfig ./scripts/verify-loki-ingestion.sh
#
# Options:
#   --timeout SECONDS    port-forward + HTTP timeout (default: 60)
#   --namespace NS       monitoring namespace (default: monitoring)
#   --local-port PORT    local port for port-forward (default: 13100)
#   --tenant NS          query a specific tenant namespace only
#   --lookback DURATION  log lookback window (default: 1h)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
MONITORING_NAMESPACE="monitoring"
LOKI_LOCAL_PORT=13100
WAIT_TIMEOUT=60
SPECIFIC_TENANT=""
LOOKBACK="1h"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)    WAIT_TIMEOUT="$2";       shift 2 ;;
    --namespace)  MONITORING_NAMESPACE="$2"; shift 2 ;;
    --local-port) LOKI_LOCAL_PORT="$2";    shift 2 ;;
    --tenant)     SPECIFIC_TENANT="$2";    shift 2 ;;
    --lookback)   LOOKBACK="$2";           shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log()    { echo -e "${GREEN}==>${NC} $*"; }
warn()   { echo -e "${YELLOW}WARN:${NC} $*"; }
err()    { echo -e "${RED}ERROR:${NC} $*" >&2; }
info()   { echo "    $*"; }
step()   { echo -e "  ${CYAN}•${NC} $*"; }
ok()     { echo -e "  ${GREEN}✓${NC} $*"; }
fail()   { echo -e "  ${RED}✗${NC} $*"; }
header() { echo -e "\n${BOLD}$*${NC}"; }

LOKI_URL="http://localhost:${LOKI_LOCAL_PORT}"

# ── Cleanup trap ──────────────────────────────────────────────────────────────
PF_PID=""
cleanup() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
    PF_PID=""
  fi
}
trap cleanup EXIT INT TERM

# ── Prerequisite check ────────────────────────────────────────────────────────
for cmd in kubectl curl jq; do
  if ! command -v "${cmd}" &>/dev/null; then
    err "Required command not found: ${cmd}"
    exit 1
  fi
done

if [[ -z "${KUBECONFIG:-}" ]]; then
  warn "KUBECONFIG not set — using default ~/.kube/config"
fi

# ── Locate Loki gateway service ───────────────────────────────────────────────
log "Locating Loki gateway in namespace '${MONITORING_NAMESPACE}' ..."

LOKI_SVC=""
# Prefer loki-gateway (nginx proxy with auth); fall back to loki direct
if kubectl get svc loki-gateway -n "${MONITORING_NAMESPACE}" &>/dev/null; then
  LOKI_SVC="loki-gateway"
  LOKI_SVC_PORT=80
  info "Found service: loki-gateway (nginx gateway)"
elif kubectl get svc loki -n "${MONITORING_NAMESPACE}" &>/dev/null; then
  LOKI_SVC="loki"
  LOKI_SVC_PORT=3100
  info "Found service: loki (direct HTTP)"
else
  err "No Loki service found in namespace '${MONITORING_NAMESPACE}'"
  err "Ensure Loki is installed: helm list -n ${MONITORING_NAMESPACE}"
  exit 1
fi

# ── Start port-forward ────────────────────────────────────────────────────────
log "Starting port-forward ${LOKI_LOCAL_PORT} → svc/${LOKI_SVC}:${LOKI_SVC_PORT} ..."

kubectl port-forward \
  -n "${MONITORING_NAMESPACE}" \
  "svc/${LOKI_SVC}" \
  "${LOKI_LOCAL_PORT}:${LOKI_SVC_PORT}" \
  >/dev/null 2>&1 &
PF_PID=$!

# Wait for port-forward to be ready
READY=false
for i in $(seq 1 20); do
  if curl -sf --max-time 3 "${LOKI_URL}/ready" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done

if [[ "${READY}" != "true" ]]; then
  err "Loki port-forward not ready after 20s"
  err "Check Loki pod status: kubectl get pods -n ${MONITORING_NAMESPACE} -l app.kubernetes.io/name=loki"
  exit 1
fi
ok "Loki gateway reachable at ${LOKI_URL}"

# ── Check Loki readiness endpoint ─────────────────────────────────────────────
header "Step 1: Loki health check"

READY_RESP=$(curl -sf --max-time 10 "${LOKI_URL}/ready" 2>&1 || echo "FAILED")
if [[ "${READY_RESP}" == *"ready"* ]]; then
  ok "Loki reports: ready"
else
  warn "Loki /ready response: ${READY_RESP}"
fi

# ── Discover tenant namespaces ────────────────────────────────────────────────
header "Step 2: Discover tenant namespaces"

TENANT_NAMESPACES=()
if [[ -n "${SPECIFIC_TENANT}" ]]; then
  TENANT_NAMESPACES=("${SPECIFIC_TENANT}")
  info "Using specified tenant: ${SPECIFIC_TENANT}"
else
  # Find namespaces labelled as botcms.cloud tenants
  mapfile -t TENANT_NAMESPACES < <(
    kubectl get namespaces \
      -l "botcms.cloud/tenant" \
      -o jsonpath='{.items[*].metadata.name}' 2>/dev/null \
      | tr ' ' '\n' \
      | grep -v '^$' \
      || true
  )
fi

if [[ ${#TENANT_NAMESPACES[@]} -eq 0 ]]; then
  warn "No tenant namespaces found (label: botcms.cloud/tenant)"
  warn "Falling back to 'monitoring' namespace to verify Loki ingest pipeline"
  TENANT_NAMESPACES=("monitoring")
  FALLBACK_MODE=true
else
  FALLBACK_MODE=false
  info "Found ${#TENANT_NAMESPACES[@]} tenant namespace(s): ${TENANT_NAMESPACES[*]}"
fi

# ── Helper: query Loki for a given org-id (namespace) ────────────────────────
# Returns 0 if streams found, 1 otherwise
query_loki_streams() {
  local org_id="$1"
  local lookback_ns
  # Convert lookback to nanoseconds for start parameter
  local now_ns
  now_ns=$(date +%s%N)
  local lookback_s
  case "${LOOKBACK}" in
    *h) lookback_s=$(( ${LOOKBACK%h} * 3600 )) ;;
    *m) lookback_s=$(( ${LOOKBACK%m} * 60 )) ;;
    *s) lookback_s=${LOOKBACK%s} ;;
    *)  lookback_s=3600 ;;
  esac
  local start_ns=$(( now_ns - lookback_s * 1000000000 ))

  # Query label values for 'namespace' label within this org's logs
  local labels_resp
  labels_resp=$(curl -sf \
    --max-time "${WAIT_TIMEOUT}" \
    -H "X-Scope-OrgID: ${org_id}" \
    "${LOKI_URL}/loki/api/v1/label/namespace/values?start=${start_ns}&end=${now_ns}" \
    2>/dev/null || echo '{"status":"error"}')

  local ns_values
  ns_values=$(echo "${labels_resp}" | jq -r '.data[]?' 2>/dev/null | tr '\n' ',' | sed 's/,$//')

  if [[ -z "${ns_values}" ]]; then
    return 1
  fi
  echo "${ns_values}"
  return 0
}

# Returns stream count for given org_id and stream selector
query_loki_stream_count() {
  local org_id="$1"
  local selector="${2:-{namespace=\"${org_id}\"}}"
  local now_ns
  now_ns=$(date +%s%N)
  local lookback_s
  case "${LOOKBACK}" in
    *h) lookback_s=$(( ${LOOKBACK%h} * 3600 )) ;;
    *m) lookback_s=$(( ${LOOKBACK%m} * 60 )) ;;
    *s) lookback_s=${LOOKBACK%s} ;;
    *)  lookback_s=3600 ;;
  esac
  local start_ns=$(( now_ns - lookback_s * 1000000000 ))

  local series_resp
  series_resp=$(curl -sf \
    --max-time "${WAIT_TIMEOUT}" \
    -H "X-Scope-OrgID: ${org_id}" \
    --data-urlencode "match[]=${selector}" \
    --data-urlencode "start=${start_ns}" \
    --data-urlencode "end=${now_ns}" \
    "${LOKI_URL}/loki/api/v1/series" \
    2>/dev/null || echo '{"status":"error","data":[]}')

  echo "${series_resp}" | jq '.data | length' 2>/dev/null || echo "0"
}

# Returns a sample log line for given org_id
query_loki_sample_log() {
  local org_id="$1"
  local selector="${2:-{namespace=\"${org_id}\"}}"
  local now_ns
  now_ns=$(date +%s%N)
  local lookback_s
  case "${LOOKBACK}" in
    *h) lookback_s=$(( ${LOOKBACK%h} * 3600 )) ;;
    *m) lookback_s=$(( ${LOOKBACK%m} * 60 )) ;;
    *s) lookback_s=${LOOKBACK%s} ;;
    *)  lookback_s=3600 ;;
  esac
  local start_ns=$(( now_ns - lookback_s * 1000000000 ))

  local query_resp
  query_resp=$(curl -sf \
    --max-time "${WAIT_TIMEOUT}" \
    -H "X-Scope-OrgID: ${org_id}" \
    --get \
    --data-urlencode "query=${selector}" \
    --data-urlencode "start=${start_ns}" \
    --data-urlencode "end=${now_ns}" \
    --data-urlencode "limit=1" \
    --data-urlencode "direction=backward" \
    "${LOKI_URL}/loki/api/v1/query_range" \
    2>/dev/null || echo '{"status":"error"}')

  echo "${query_resp}" | jq -r \
    '.data.result[0].values[0][1]? // empty' 2>/dev/null \
    | head -c 200
}

# ── Per-tenant verification ───────────────────────────────────────────────────
header "Step 3: Query Loki for log streams per tenant namespace"

PASS_COUNT=0
FAIL_COUNT=0
declare -A TENANT_RESULTS

for NS in "${TENANT_NAMESPACES[@]}"; do
  echo ""
  step "Tenant namespace: ${NS}"

  # Check available label values
  NS_LABELS=$(query_loki_streams "${NS}" || true)

  if [[ -z "${NS_LABELS}" ]]; then
    fail "No 'namespace' label values found for org-id '${NS}' in last ${LOOKBACK}"
    info "Either no logs ingested yet, or Promtail has not synced this namespace."
    TENANT_RESULTS["${NS}"]="NO_STREAMS"
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
    continue
  fi

  info "Namespace label values in logs: ${NS_LABELS}"

  # Count active streams
  STREAM_COUNT=$(query_loki_stream_count "${NS}")
  if [[ "${STREAM_COUNT}" -eq 0 ]]; then
    # Try broader selector in case namespace label is absent but org-id routed correctly
    STREAM_COUNT=$(query_loki_stream_count "${NS}" "{job=~\".+\"}")
  fi

  if [[ "${STREAM_COUNT}" -gt 0 ]]; then
    ok "Found ${STREAM_COUNT} active log stream(s) for namespace '${NS}'"

    # Fetch a sample log line
    SAMPLE=$(query_loki_sample_log "${NS}" || true)
    if [[ -n "${SAMPLE}" ]]; then
      info "Sample log entry (truncated): ${SAMPLE:0:160}"
    fi

    TENANT_RESULTS["${NS}"]="OK:${STREAM_COUNT}"
    PASS_COUNT=$(( PASS_COUNT + 1 ))
  else
    fail "Zero streams found for namespace '${NS}' — logs may not be flowing yet"
    info "Check Promtail targets: kubectl logs -n ${MONITORING_NAMESPACE} -l app.kubernetes.io/name=promtail --tail=50"
    TENANT_RESULTS["${NS}"]="NO_STREAMS"
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  fi
done

# ── Global label sanity check ─────────────────────────────────────────────────
header "Step 4: Verify Loki global label index (cluster-wide)"

# Using the first tenant namespace (or monitoring) as org-id for all-label check
PROBE_NS="${TENANT_NAMESPACES[0]}"
ALL_LABELS=$(curl -sf \
  --max-time "${WAIT_TIMEOUT}" \
  -H "X-Scope-OrgID: ${PROBE_NS}" \
  "${LOKI_URL}/loki/api/v1/labels" \
  2>/dev/null || echo '{"status":"error"}')

LABEL_COUNT=$(echo "${ALL_LABELS}" | jq '.data | length' 2>/dev/null || echo "0")
LABEL_NAMES=$(echo "${ALL_LABELS}" | jq -r '.data[]?' 2>/dev/null | tr '\n' ',' | sed 's/,$//')

if [[ "${LABEL_COUNT}" -gt 0 ]]; then
  ok "Loki label index has ${LABEL_COUNT} label(s) for org '${PROBE_NS}': ${LABEL_NAMES}"
else
  warn "No labels in Loki label index for org '${PROBE_NS}' — Promtail may not be shipping logs yet"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
header "═══════════════════ Loki Ingestion Verification Summary ═══════════════════"
echo ""
echo "  Lookback window : ${LOOKBACK}"
echo "  Loki service    : svc/${LOKI_SVC} in ${MONITORING_NAMESPACE}"
echo "  Mode            : ${FALLBACK_MODE:+FALLBACK (no tenant namespaces found)}${FALLBACK_MODE:-TENANT}"
echo ""

if [[ ${#TENANT_NAMESPACES[@]} -eq 0 ]]; then
  warn "No namespaces queried."
else
  printf "  %-30s  %s\n" "NAMESPACE" "STATUS"
  printf "  %-30s  %s\n" "─────────────────────────────" "──────────────────────"
  for NS in "${TENANT_NAMESPACES[@]}"; do
    RESULT="${TENANT_RESULTS["${NS}"]:-UNKNOWN}"
    if [[ "${RESULT}" == OK:* ]]; then
      printf "  %-30s  ${GREEN}✓ %s streams${NC}\n" "${NS}" "${RESULT#OK:}"
    else
      printf "  %-30s  ${RED}✗ no streams${NC}\n" "${NS}"
    fi
  done
fi

echo ""
if [[ "${PASS_COUNT}" -gt 0 ]]; then
  echo -e "${GREEN}RESULT: PASS${NC} — Loki is ingesting logs from ${PASS_COUNT}/${#TENANT_NAMESPACES[@]} namespace(s)"
  if [[ "${FALLBACK_MODE}" == "true" ]]; then
    warn "Verified on fallback namespace 'monitoring' — deploy a tenant with ./tenant-add.sh for full validation"
  fi
  EXIT_CODE=0
else
  echo -e "${RED}RESULT: FAIL${NC} — No log streams found in any queried namespace"
  echo ""
  echo "  Troubleshooting steps:"
  echo "  1. Verify Promtail pods are running:"
  echo "     kubectl get pods -n ${MONITORING_NAMESPACE} -l app.kubernetes.io/name=promtail"
  echo "  2. Check Promtail logs for errors:"
  echo "     kubectl logs -n ${MONITORING_NAMESPACE} -l app.kubernetes.io/name=promtail --tail=100"
  echo "  3. Verify Loki pods are running:"
  echo "     kubectl get pods -n ${MONITORING_NAMESPACE} -l app.kubernetes.io/name=loki"
  echo "  4. Check Loki ingestion errors:"
  echo "     kubectl logs -n ${MONITORING_NAMESPACE} -l app.kubernetes.io/name=loki --tail=100"
  echo "  5. Re-run with shorter lookback once logs start flowing:"
  echo "     KUBECONFIG=./kubeconfig ./scripts/verify-loki-ingestion.sh --lookback 5m"
  EXIT_CODE=1
fi

echo ""
exit "${EXIT_CODE}"
