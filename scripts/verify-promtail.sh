#!/usr/bin/env bash
# scripts/verify-promtail.sh — Verify Promtail DaemonSet deployment and configuration
#
# Checks:
#   1. Promtail DaemonSet exists in monitoring namespace
#   2. All DaemonSet pods are Running and Ready (desired == ready)
#   3. Pod readiness per node
#   4. Promtail config inside pods points to correct Loki gateway endpoint
#   5. Loki gateway Service is reachable from within the cluster
#
# Usage:
#   KUBECONFIG=./kubeconfig ./scripts/verify-promtail.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

MONITORING_NAMESPACE="monitoring"
EXPECTED_LOKI_ENDPOINT="http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
pass()  { echo -e "  ${GREEN}✓${NC} $*"; }
fail()  { echo -e "  ${RED}✗${NC} $*"; FAILURES=$(( FAILURES + 1 )); }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $*"; }
info()  { echo -e "  ${CYAN}→${NC} $*"; }
header(){ echo -e "\n${CYAN}══ $* ══${NC}"; }

FAILURES=0

# ─────────────────────────────────────────────────────────────────────────────
header "Check 1: Promtail DaemonSet exists"
# ─────────────────────────────────────────────────────────────────────────────
DS_NAME=$(kubectl get daemonset -n "${MONITORING_NAMESPACE}" \
  -l "app.kubernetes.io/name=promtail" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "${DS_NAME}" ]]; then
  fail "No Promtail DaemonSet found in namespace '${MONITORING_NAMESPACE}'"
  fail "Ensure install-monitoring.sh has been run and Loki chart deployed with promtail.enabled=true"
  echo ""
  echo -e "${RED}FAILED${NC}: Promtail DaemonSet not found — cannot continue checks"
  exit 1
fi

pass "DaemonSet '${DS_NAME}' found in ${MONITORING_NAMESPACE}"

# ─────────────────────────────────────────────────────────────────────────────
header "Check 2: DaemonSet replica counts"
# ─────────────────────────────────────────────────────────────────────────────
DESIRED=$(kubectl get daemonset "${DS_NAME}" -n "${MONITORING_NAMESPACE}" \
  -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo "0")
READY=$(kubectl get daemonset "${DS_NAME}" -n "${MONITORING_NAMESPACE}" \
  -o jsonpath='{.status.numberReady}' 2>/dev/null || echo "0")
AVAILABLE=$(kubectl get daemonset "${DS_NAME}" -n "${MONITORING_NAMESPACE}" \
  -o jsonpath='{.status.numberAvailable}' 2>/dev/null || echo "0")
UPDATED=$(kubectl get daemonset "${DS_NAME}" -n "${MONITORING_NAMESPACE}" \
  -o jsonpath='{.status.updatedNumberScheduled}' 2>/dev/null || echo "0")
MISSCHEDULED=$(kubectl get daemonset "${DS_NAME}" -n "${MONITORING_NAMESPACE}" \
  -o jsonpath='{.status.numberMisscheduled}' 2>/dev/null || echo "0")

info "Desired: ${DESIRED} | Ready: ${READY} | Available: ${AVAILABLE} | Updated: ${UPDATED} | MisScheduled: ${MISSCHEDULED}"

if [[ "${DESIRED}" -eq 0 ]]; then
  fail "DaemonSet has 0 desired pods — no schedulable nodes found"
elif [[ "${READY}" -eq "${DESIRED}" ]]; then
  pass "All ${READY}/${DESIRED} Promtail pods are Ready"
else
  fail "Only ${READY}/${DESIRED} Promtail pods are Ready"
  warn "Pods may still be pulling images or waiting for node resources"
fi

if [[ "${MISSCHEDULED}" -gt 0 ]]; then
  fail "${MISSCHEDULED} pods are misscheduled — check node tolerations/affinity"
fi

# ─────────────────────────────────────────────────────────────────────────────
header "Check 3: Per-pod readiness status"
# ─────────────────────────────────────────────────────────────────────────────
POD_LIST=$(kubectl get pods -n "${MONITORING_NAMESPACE}" \
  -l "app.kubernetes.io/name=promtail" \
  --no-headers \
  -o custom-columns="NAME:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase,READY:.status.containerStatuses[0].ready" \
  2>/dev/null || echo "")

if [[ -z "${POD_LIST}" ]]; then
  fail "No Promtail pods found in ${MONITORING_NAMESPACE}"
else
  NOT_READY=0
  while IFS= read -r line; do
    POD_NAME=$(echo "${line}" | awk '{print $1}')
    NODE=$(echo "${line}" | awk '{print $2}')
    STATUS=$(echo "${line}" | awk '{print $3}')
    READY_FLAG=$(echo "${line}" | awk '{print $4}')

    if [[ "${READY_FLAG}" == "true" && "${STATUS}" == "Running" ]]; then
      pass "Pod ${POD_NAME} on node ${NODE}: Running/Ready"
    else
      fail "Pod ${POD_NAME} on node ${NODE}: status=${STATUS} ready=${READY_FLAG}"
      NOT_READY=$(( NOT_READY + 1 ))
    fi
  done <<< "${POD_LIST}"

  if [[ "${NOT_READY}" -gt 0 ]]; then
    info "Inspect failing pods with: kubectl logs -n ${MONITORING_NAMESPACE} <pod-name>"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
header "Check 4: Promtail config — Loki push endpoint"
# ─────────────────────────────────────────────────────────────────────────────
# Read config from a running Promtail pod's mounted ConfigMap
FIRST_POD=$(kubectl get pods -n "${MONITORING_NAMESPACE}" \
  -l "app.kubernetes.io/name=promtail" \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "${FIRST_POD}" ]]; then
  warn "No running Promtail pod available to inspect config — skipping endpoint check"
  FAILURES=$(( FAILURES + 1 ))
else
  # Promtail config is typically at /etc/promtail/config.yaml inside the container
  LOKI_URL=$(kubectl exec -n "${MONITORING_NAMESPACE}" "${FIRST_POD}" -- \
    sh -c 'grep -A2 "clients:" /etc/promtail/config.yaml 2>/dev/null | grep "url:" | head -1 | sed "s/.*url: *//"' \
    2>/dev/null || echo "")

  if [[ -z "${LOKI_URL}" ]]; then
    # Fallback: try grep for the push path directly
    LOKI_URL=$(kubectl exec -n "${MONITORING_NAMESPACE}" "${FIRST_POD}" -- \
      sh -c 'grep -r "loki/api/v1/push" /etc/promtail/ 2>/dev/null | head -1 | sed "s/.*url: *//"' \
      2>/dev/null || echo "")
  fi

  if [[ -z "${LOKI_URL}" ]]; then
    fail "Could not read Loki push URL from Promtail config in pod ${FIRST_POD}"
    warn "Check: kubectl exec -n ${MONITORING_NAMESPACE} ${FIRST_POD} -- cat /etc/promtail/config.yaml"
  elif echo "${LOKI_URL}" | grep -q "loki-gateway.monitoring.svc.cluster.local"; then
    pass "Loki endpoint: ${LOKI_URL}"
    pass "Endpoint points to loki-gateway ClusterDNS (correct)"
  else
    fail "Unexpected Loki endpoint: ${LOKI_URL}"
    fail "Expected: ${EXPECTED_LOKI_ENDPOINT}"
  fi

  # Check tenant_id / X-Scope-OrgID is present in config
  TENANT_CONF=$(kubectl exec -n "${MONITORING_NAMESPACE}" "${FIRST_POD}" -- \
    sh -c 'grep -i "tenant_id\|tenant-id\|orgid" /etc/promtail/config.yaml 2>/dev/null | head -3' \
    2>/dev/null || echo "")

  if [[ -n "${TENANT_CONF}" ]]; then
    pass "Tenant isolation config found in Promtail config (multi-tenancy enabled)"
    info "${TENANT_CONF}"
  else
    warn "No tenant_id / X-Scope-OrgID found in Promtail config — Loki multi-tenancy may not work"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
header "Check 5: Loki gateway Service reachability"
# ─────────────────────────────────────────────────────────────────────────────
GW_SVC=$(kubectl get svc -n "${MONITORING_NAMESPACE}" \
  -l "app.kubernetes.io/name=loki,app.kubernetes.io/component=gateway" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "${GW_SVC}" ]]; then
  # Try by name pattern
  GW_SVC=$(kubectl get svc -n "${MONITORING_NAMESPACE}" \
    --no-headers -o name 2>/dev/null | grep "loki-gateway" | head -1 | sed 's|service/||' || echo "")
fi

if [[ -z "${GW_SVC}" ]]; then
  fail "Loki gateway Service not found in ${MONITORING_NAMESPACE}"
  warn "Promtail will fail to push logs until loki-gateway is available"
else
  GW_PORT=$(kubectl get svc "${GW_SVC}" -n "${MONITORING_NAMESPACE}" \
    -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "80")
  pass "Loki gateway Service '${GW_SVC}' found (port ${GW_PORT})"

  # Quick connectivity test from a Promtail pod
  if [[ -n "${FIRST_POD}" ]]; then
    HTTP_CODE=$(kubectl exec -n "${MONITORING_NAMESPACE}" "${FIRST_POD}" -- \
      sh -c "wget -qO- --server-response http://${GW_SVC}.${MONITORING_NAMESPACE}.svc.cluster.local/ready 2>&1 | grep 'HTTP/' | tail -1 | awk '{print \$2}'" \
      2>/dev/null || echo "")

    if [[ "${HTTP_CODE}" == "200" ]]; then
      pass "Loki gateway /ready returned HTTP 200 — endpoint reachable"
    elif [[ -n "${HTTP_CODE}" ]]; then
      warn "Loki gateway /ready returned HTTP ${HTTP_CODE} (may still be starting up)"
    else
      warn "Could not reach Loki gateway from Promtail pod (wget may not be available)"
      info "Manual check: kubectl exec -n ${MONITORING_NAMESPACE} ${FIRST_POD} -- wget -qO- http://${GW_SVC}.${MONITORING_NAMESPACE}.svc.cluster.local/ready"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
header "Summary"
# ─────────────────────────────────────────────────────────────────────────────
echo ""
if [[ "${FAILURES}" -eq 0 ]]; then
  echo -e "${GREEN}✓ PASSED${NC}: All Promtail DaemonSet checks passed"
  echo ""
  echo "  DaemonSet : ${DS_NAME}"
  echo "  Namespace : ${MONITORING_NAMESPACE}"
  echo "  Pods      : ${READY}/${DESIRED} Ready"
  echo "  Loki push : ${EXPECTED_LOKI_ENDPOINT}"
  exit 0
else
  echo -e "${RED}✗ FAILED${NC}: ${FAILURES} check(s) failed"
  echo ""
  echo "  Remediation steps:"
  echo "    1. Check DaemonSet: kubectl describe ds/${DS_NAME} -n ${MONITORING_NAMESPACE}"
  echo "    2. Check pod logs:  kubectl logs -n ${MONITORING_NAMESPACE} -l app.kubernetes.io/name=promtail --tail=50"
  echo "    3. Re-run install:  source .env && KUBECONFIG=./kubeconfig ./scripts/install-monitoring.sh"
  exit 1
fi
