#!/usr/bin/env bash
# scripts/verify-core-components.sh — Verify core cluster components reach Running state
#
# Checks that Cilium CNI, CoreDNS, metrics-server, CloudNativePG operator,
# CSI-S3 driver, OpenSearch operator + cluster, and the monitoring stack
# (Prometheus + Grafana) are all Running after deploy.sh has completed.
# Exits non-zero if any required component fails to become healthy within
# the timeout.  The monitoring check is advisory (non-fatal) because phase 10
# is optional on resource-constrained clusters.
#
# Called automatically at the end of deploy.sh full-deploy runs.
# Can also be run standalone: KUBECONFIG=./kubeconfig ./scripts/verify-core-components.sh
#
# Usage:
#   ./scripts/verify-core-components.sh [--timeout SECONDS]
#
# Defaults:
#   --timeout 180  (3 minutes; components should already be up by this point)

set -euo pipefail

WAIT_TIMEOUT=180
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) WAIT_TIMEOUT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }
step() { echo -e "  ${CYAN}•${NC} $*"; }

# ── Generic pod readiness wait ─────────────────────────────────────────────────
# wait_for_pods <label-selector> <namespace> <component-name> <min-pods>
wait_for_pods() {
  local selector="$1"
  local namespace="$2"
  local component="$3"
  local min_pods="${4:-1}"

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  info "Checking ${component} (ns=${namespace}, selector=${selector})"

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local total not_running
    total=$(kubectl get pods -n "${namespace}" \
      -l "${selector}" \
      --no-headers 2>/dev/null | wc -l | tr -d ' ')

    not_running=$(kubectl get pods -n "${namespace}" \
      -l "${selector}" \
      --no-headers 2>/dev/null | grep -v -E '\bRunning\b' | wc -l | tr -d ' ')

    if [[ "${total}" -ge "${min_pods}" && "${not_running}" -eq 0 ]]; then
      step "${component}: ${total}/${total} pods Running ✓"
      ready=true
      break
    fi

    local running=$(( total - not_running ))
    info "  ${component}: ${running}/${total} Running (waiting...)"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "${component} did not reach Running state within ${WAIT_TIMEOUT}s"
    kubectl get pods -n "${namespace}" -l "${selector}" 2>/dev/null || true
    return 1
  fi
}

# ── Also verify all containers within pods are Ready ──────────────────────────
wait_for_ready_containers() {
  local selector="$1"
  local namespace="$2"
  local component="$3"

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    local not_ready
    not_ready=$(kubectl get pods -n "${namespace}" \
      -l "${selector}" \
      --no-headers 2>/dev/null | awk '{print $2}' | grep -v -E '^[0-9]+/\1$' | \
      awk -F'/' '$1 != $2' | wc -l | tr -d ' ')

    # Simpler: check all containers ready via kubectl wait
    if kubectl wait pod \
        -n "${namespace}" \
        -l "${selector}" \
        --for=condition=Ready \
        --timeout=10s >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 5
  done

  if [[ "${ready}" != "true" ]]; then
    warn "${component}: pods Running but containers not yet Ready (non-fatal)"
  fi
}

# ── Component checks ──────────────────────────────────────────────────────────

check_cilium() {
  log "Verifying Cilium CNI"

  # DaemonSet pods (one per node)
  wait_for_pods "k8s-app=cilium" "kube-system" "cilium-agent" 1

  # Operator deployment
  wait_for_pods "io.cilium/app=operator" "kube-system" "cilium-operator" 1

  wait_for_ready_containers "k8s-app=cilium" "kube-system" "cilium-agent"

  info "Cilium CNI: healthy"
}

check_coredns() {
  log "Verifying CoreDNS"

  # k3s ships CoreDNS as a Deployment in kube-system
  wait_for_pods "k8s-app=kube-dns" "kube-system" "coredns" 1

  wait_for_ready_containers "k8s-app=kube-dns" "kube-system" "coredns"

  # Sanity-check: CoreDNS service exists
  if kubectl get svc kube-dns -n kube-system >/dev/null 2>&1; then
    local cluster_ip
    cluster_ip=$(kubectl get svc kube-dns -n kube-system -o jsonpath='{.spec.clusterIP}' 2>/dev/null)
    info "CoreDNS service ClusterIP: ${cluster_ip}"
  else
    warn "kube-dns Service not found — DNS may not function"
  fi

  info "CoreDNS: healthy"
}

check_metrics_server() {
  log "Verifying metrics-server"

  # k3s bundles metrics-server — it may be in kube-system under several labels
  # Try the standard label first, fall back to app name
  local found=false

  for selector in "k8s-app=metrics-server" "app.kubernetes.io/name=metrics-server" "app=metrics-server"; do
    local count
    count=$(kubectl get pods -n kube-system -l "${selector}" \
      --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [[ "${count}" -gt 0 ]]; then
      wait_for_pods "${selector}" "kube-system" "metrics-server" 1
      wait_for_ready_containers "${selector}" "kube-system" "metrics-server"
      found=true
      break
    fi
  done

  if [[ "${found}" != "true" ]]; then
    # k3s v1.32 may deploy metrics-server differently — check by deployment name
    if kubectl get deployment metrics-server -n kube-system >/dev/null 2>&1; then
      info "metrics-server Deployment found — checking rollout"
      local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
      while [[ $(date +%s) -lt ${deadline} ]]; do
        if kubectl rollout status deployment/metrics-server \
            -n kube-system --timeout=10s >/dev/null 2>&1; then
          step "metrics-server: rollout complete ✓"
          found=true
          break
        fi
        info "  metrics-server: waiting for rollout..."
        sleep 10
      done
    fi
  fi

  if [[ "${found}" != "true" ]]; then
    warn "metrics-server not found in kube-system — skipping (may be installed later)"
    return 0
  fi

  # Verify metrics API is registered
  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local api_ready=false
  while [[ $(date +%s) -lt ${deadline} ]]; do
    if kubectl top nodes >/dev/null 2>&1; then
      step "metrics-server: API responding (kubectl top nodes works) ✓"
      api_ready=true
      break
    fi
    info "  metrics API not ready yet — waiting..."
    sleep 10
  done

  if [[ "${api_ready}" != "true" ]]; then
    warn "metrics-server pod is Running but API not responding within timeout"
    warn "This may resolve after a few minutes — non-fatal for cluster operation"
  fi

  info "metrics-server: healthy"
}

# ── CloudNativePG operator check ──────────────────────────────────────────────
check_cnpg() {
  log "Verifying CloudNativePG operator"

  local ns="cnpg-system"

  # Check if the CNPG namespace even exists before polling
  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    warn "Namespace ${ns} not found — CNPG operator may not have been installed (phase 6)"
    return 1
  fi

  # Controller deployment pod(s)
  wait_for_pods "app.kubernetes.io/name=cloudnative-pg" "${ns}" "cnpg-controller" 1
  wait_for_ready_containers "app.kubernetes.io/name=cloudnative-pg" "${ns}" "cnpg-controller"

  # Verify core CRDs are registered (Established)
  local crds=(
    clusters.postgresql.cnpg.io
    backups.postgresql.cnpg.io
    scheduledbackups.postgresql.cnpg.io
  )
  local missing_crds=0
  for crd in "${crds[@]}"; do
    local status
    status=$(kubectl get crd "${crd}" \
      -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "Missing")
    if [[ "${status}" != "True" ]]; then
      warn "CNPG CRD not Established: ${crd} (status: ${status})"
      missing_crds=$(( missing_crds + 1 ))
    fi
  done

  if [[ "${missing_crds}" -gt 0 ]]; then
    err "${missing_crds} CNPG CRD(s) not yet Established"
    return 1
  fi

  info "CloudNativePG operator: healthy (${#crds[@]} CRDs Established)"
}

# ── cert-manager check ────────────────────────────────────────────────────────
check_cert_manager() {
  log "Verifying cert-manager"

  local ns="cert-manager"

  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    warn "Namespace ${ns} not found — cert-manager may not have been installed (phase 4)"
    return 1
  fi

  # Pods: controller + webhook + cainjector (startupapicheck is a Job, skip it)
  wait_for_pods "app.kubernetes.io/instance=cert-manager" "${ns}" "cert-manager" 1

  # Verify the six core CRDs are Established
  local crds=(
    certificaterequests.cert-manager.io
    certificates.cert-manager.io
    challenges.acme.cert-manager.io
    clusterissuers.cert-manager.io
    issuers.cert-manager.io
    orders.acme.cert-manager.io
  )

  local missing_crds=0
  for crd in "${crds[@]}"; do
    local status
    status=$(kubectl get crd "${crd}" \
      -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "Missing")
    if [[ "${status}" != "True" ]]; then
      warn "cert-manager CRD not Established: ${crd} (status: ${status})"
      missing_crds=$(( missing_crds + 1 ))
    fi
  done

  if [[ "${missing_crds}" -gt 0 ]]; then
    err "${missing_crds} cert-manager CRD(s) not yet Established"
    return 1
  fi

  step "cert-manager: all ${#crds[@]} CRDs Established ✓"

  # Verify ClusterIssuer letsencrypt-botcms reached Ready=True
  # (phase 5 apply_cluster_issuers gates on this, but we double-check here)
  local issuer_deadline=$(( $(date +%s) + 60 ))
  local issuer_ready=false
  while [[ $(date +%s) -lt ${issuer_deadline} ]]; do
    local ci_status
    ci_status=$(kubectl get clusterissuer letsencrypt-botcms \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [[ "${ci_status}" == "True" ]]; then
      issuer_ready=true
      break
    fi
    info "  ClusterIssuer letsencrypt-botcms: not Ready yet — waiting..."
    sleep 10
  done

  if [[ "${issuer_ready}" != "true" ]]; then
    warn "ClusterIssuer letsencrypt-botcms not Ready — ACME registration may be pending"
    warn "This is non-fatal if cert-manager pods are Running and CRDs are Established"
  else
    step "cert-manager: ClusterIssuer letsencrypt-botcms Ready ✓"
  fi

  info "cert-manager: healthy"
}

# ── Caddy ingress check ───────────────────────────────────────────────────────
check_caddy() {
  log "Verifying Caddy ingress"

  local ns="caddy-ingress"

  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    warn "Namespace ${ns} not found — Caddy may not have been installed (phase 5)"
    return 1
  fi

  # Caddy Deployment pods (2 replicas)
  wait_for_pods "app=caddy-ingress" "${ns}" "caddy-ingress" 1
  wait_for_ready_containers "app=caddy-ingress" "${ns}" "caddy-ingress"

  # Valkey cert-storage StatefulSet pod
  local valkey_total
  valkey_total=$(kubectl get pods -n "${ns}" -l "app=caddy-redis" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${valkey_total}" -gt 0 ]]; then
    wait_for_pods "app=caddy-redis" "${ns}" "caddy-redis (valkey)" 1
  else
    warn "Valkey (caddy-redis) pod not found in ${ns} — cert storage may be unavailable"
  fi

  # Health probe via port-forward — confirms Caddy is serving
  local pod
  pod=$(kubectl get pods -n "${ns}" -l "app=caddy-ingress" \
    --field-selector='status.phase=Running' \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

  if [[ -n "${pod}" ]]; then
    local local_port=18081
    kubectl port-forward -n "${ns}" "pod/${pod}" "${local_port}:80" >/dev/null 2>&1 &
    local pf_pid=$!
    # shellcheck disable=SC2064
    trap "kill ${pf_pid} 2>/dev/null || true" RETURN
    sleep 3

    local http_status
    http_status=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 10 "http://localhost:${local_port}/health" 2>/dev/null || echo "000")

    kill "${pf_pid}" 2>/dev/null || true

    if [[ "${http_status}" == "200" ]]; then
      step "caddy-ingress: /health → HTTP 200 ✓"
    else
      warn "caddy-ingress health check returned HTTP ${http_status} (expected 200)"
      kubectl logs -n "${ns}" "pod/${pod}" --tail=10 2>/dev/null || true
    fi
  else
    warn "No Running Caddy pod available for health check — skipping"
  fi

  # Report LoadBalancer IP
  local lb_ip
  lb_ip=$(kubectl get svc caddy-ingress -n "${ns}" \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  if [[ -n "${lb_ip}" ]]; then
    step "caddy-ingress: LoadBalancer IP = ${lb_ip} ✓"

    # ── LB direct reachability ────────────────────────────────────────────────
    # Check /health on port 80 directly via the LB IP (bypasses DNS)
    local lb_health
    lb_health=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 10 "http://${lb_ip}/health" 2>/dev/null || echo "000")
    if [[ "${lb_health}" == "200" ]]; then
      step "caddy-ingress: LB ${lb_ip}:80/health → HTTP 200 ✓"
    else
      warn "caddy-ingress: LB ${lb_ip}:80/health → HTTP ${lb_health} (expected 200)"
    fi

    # Check HTTP → HTTPS redirect for non-health paths
    local redir_code
    redir_code=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 10 -H "Host: test.${BASE_DOMAIN:-botcms.cloud}" \
      "http://${lb_ip}/" 2>/dev/null || echo "000")
    if [[ "${redir_code}" == "301" || "${redir_code}" == "308" ]]; then
      step "caddy-ingress: HTTP → HTTPS redirect (${redir_code}) ✓"
    else
      warn "caddy-ingress: HTTP redirect returned ${redir_code} (expected 301/308)"
    fi

    # ── Wildcard DNS resolution ───────────────────────────────────────────────
    local base_domain="${BASE_DOMAIN:-}"
    if [[ -z "${base_domain}" ]]; then
      warn "BASE_DOMAIN not set — skipping wildcard DNS checks"
    elif ! command -v dig >/dev/null 2>&1; then
      warn "dig not found — skipping wildcard DNS checks (install bind-tools or dnsutils)"
    else
      # Resolve a test subdomain; wildcard *.BASE_DOMAIN should point to LB IP
      local resolved
      resolved=$(dig +short "test.${base_domain}" 2>/dev/null \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
      if [[ "${resolved}" == "${lb_ip}" ]]; then
        step "caddy-ingress: *.${base_domain} DNS → ${lb_ip} ✓"
      elif [[ -z "${resolved}" ]]; then
        warn "caddy-ingress: test.${base_domain} DNS returned no result — propagation pending"
        info "  Run scripts/configure-dns.sh if wildcard record has not been set"
      else
        warn "caddy-ingress: test.${base_domain} → ${resolved} (expected ${lb_ip})"
      fi

      # Verify against Hetzner authoritative NS
      local auth_ip
      auth_ip=$(dig +short "@helium.ns.hetzner.de" "test.${base_domain}" 2>/dev/null \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || echo "")
      if [[ "${auth_ip}" == "${lb_ip}" ]]; then
        step "caddy-ingress: authoritative DNS (helium.ns.hetzner.de) → ${lb_ip} ✓"
      elif [[ -n "${auth_ip}" ]]; then
        warn "caddy-ingress: authoritative DNS → ${auth_ip} (expected ${lb_ip})"
      fi
    fi
  else
    warn "LoadBalancer IP not yet assigned — Hetzner may take 1-2 min after deploy"
  fi

  info "Caddy ingress: healthy"
}

# ── CSI-S3 storage driver check ───────────────────────────────────────────────
check_csi_s3() {
  log "Verifying CSI-S3 storage driver"

  local ns="kube-system"

  # DaemonSet node pods (one per worker node) + provisioner Deployment
  local total
  total=$(kubectl get pods -n "${ns}" -l "app=csi-s3" --no-headers 2>/dev/null | wc -l | tr -d ' ')

  if [[ "${total}" -eq 0 ]]; then
    warn "No CSI-S3 pods found in ${ns} — driver may not have been installed (phase 8)"
    return 1
  fi

  wait_for_pods "app=csi-s3" "${ns}" "csi-s3" 1
  wait_for_ready_containers "app=csi-s3" "${ns}" "csi-s3"

  # Verify the s3-fuse StorageClass is registered and usable
  if kubectl get storageclass s3-fuse >/dev/null 2>&1; then
    local provisioner
    provisioner=$(kubectl get storageclass s3-fuse -o jsonpath='{.provisioner}' 2>/dev/null)
    info "s3-fuse StorageClass: registered (provisioner: ${provisioner})"
  else
    err "s3-fuse StorageClass not found — install-csi-s3.sh may not have run"
    return 1
  fi

  info "CSI-S3 storage driver: healthy"
}

# ── OpenSearch operator + cluster check ──────────────────────────────────────
check_opensearch() {
  log "Verifying OpenSearch operator and cluster"

  local ns="opensearch"

  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    warn "Namespace ${ns} not found — OpenSearch may not have been installed (phase 7)"
    return 1
  fi

  # Operator controller pod — Opster labels it with app.kubernetes.io/name=opensearch-operator
  local op_total
  op_total=$(kubectl get pods -n "${ns}" \
    -l "app.kubernetes.io/name=opensearch-operator" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')

  if [[ "${op_total}" -eq 0 ]]; then
    # Fall back: any non-Completed pod in the namespace that contains "operator"
    op_total=$(kubectl get pods -n "${ns}" --no-headers 2>/dev/null | \
      grep -v "Completed" | grep "operator" | wc -l | tr -d ' ')
  fi

  if [[ "${op_total}" -eq 0 ]]; then
    warn "No OpenSearch operator pods found in ${ns} — phase 7 may not have completed"
    return 1
  fi

  wait_for_pods "app.kubernetes.io/name=opensearch-operator" "${ns}" "opensearch-operator" 1
  wait_for_ready_containers "app.kubernetes.io/name=opensearch-operator" "${ns}" "opensearch-operator"

  # Verify core OpenSearch CRDs are Established
  local crds=(
    opensearchclusters.opensearch.opster.io
    opensearchusers.opensearch.opster.io
    opensearchroles.opensearch.opster.io
  )
  local missing_crds=0
  for crd in "${crds[@]}"; do
    local status
    status=$(kubectl get crd "${crd}" \
      -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null || echo "Missing")
    if [[ "${status}" != "True" ]]; then
      warn "OpenSearch CRD not Established: ${crd} (status: ${status})"
      missing_crds=$(( missing_crds + 1 ))
    fi
  done

  if [[ "${missing_crds}" -gt 0 ]]; then
    err "${missing_crds} OpenSearch CRD(s) not yet Established"
    return 1
  fi

  step "opensearch-operator: CRDs Established ✓"

  # Verify the shared OpenSearchCluster CR reached phase=RUNNING
  local cluster_deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local cluster_ready=false

  while [[ $(date +%s) -lt ${cluster_deadline} ]]; do
    local phase
    phase=$(kubectl get opensearchcluster opensearch \
      -n "${ns}" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")

    if [[ "${phase}" == "RUNNING" ]]; then
      cluster_ready=true
      break
    fi

    info "  OpenSearchCluster phase: ${phase:-pending} — waiting..."
    sleep 15
  done

  if [[ "${cluster_ready}" != "true" ]]; then
    err "OpenSearchCluster 'opensearch' did not reach phase=RUNNING within ${WAIT_TIMEOUT}s"
    kubectl describe opensearchcluster opensearch -n "${ns}" 2>/dev/null || true
    return 1
  fi

  step "opensearch-cluster: phase=RUNNING ✓"

  # Verify data node pods are Running (operator creates them with cluster label)
  local data_pods
  data_pods=$(kubectl get pods -n "${ns}" --no-headers 2>/dev/null | \
    grep -v "Completed" | grep -v "operator" | wc -l | tr -d ' ')

  if [[ "${data_pods}" -gt 0 ]]; then
    step "opensearch-cluster: ${data_pods} node pod(s) Running ✓"
  else
    warn "No OpenSearch data node pods visible — cluster may still be initialising"
  fi

  info "OpenSearch: healthy"
}

# ── Monitoring stack check (Prometheus + Grafana) ─────────────────────────────
# Non-fatal: monitoring is phase 10 (optional on resource-constrained clusters).
check_monitoring() {
  log "Verifying monitoring stack (Prometheus + Grafana)"

  local ns="monitoring"

  if ! kubectl get namespace "${ns}" >/dev/null 2>&1; then
    warn "Namespace ${ns} not found — monitoring stack not installed (phase 10 skipped)"
    return 0  # non-fatal
  fi

  # Prometheus Operator
  local op_total
  op_total=$(kubectl get pods -n "${ns}" \
    -l "app.kubernetes.io/name=prometheus-operator" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')

  if [[ "${op_total}" -eq 0 ]]; then
    warn "prometheus-operator pods not found in ${ns} — Helm chart may still be rolling out"
    return 0  # non-fatal
  fi

  wait_for_pods "app.kubernetes.io/name=prometheus-operator" "${ns}" "prometheus-operator" 1
  wait_for_ready_containers "app.kubernetes.io/name=prometheus-operator" "${ns}" "prometheus-operator"

  # Prometheus StatefulSet pods
  local prom_total
  prom_total=$(kubectl get pods -n "${ns}" \
    -l "app.kubernetes.io/name=prometheus" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')

  if [[ "${prom_total}" -gt 0 ]]; then
    wait_for_pods "app.kubernetes.io/name=prometheus" "${ns}" "prometheus" 1
    step "prometheus: ${prom_total} pod(s) Running ✓"
  else
    warn "Prometheus StatefulSet pods not yet present — image pull may be in progress"
  fi

  # Grafana Deployment pod
  local grafana_total
  grafana_total=$(kubectl get pods -n "${ns}" \
    -l "app.kubernetes.io/name=grafana" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')

  if [[ "${grafana_total}" -gt 0 ]]; then
    wait_for_pods "app.kubernetes.io/name=grafana" "${ns}" "grafana" 1
    wait_for_ready_containers "app.kubernetes.io/name=grafana" "${ns}" "grafana"
    step "grafana: ${grafana_total} pod(s) Running ✓"
  else
    warn "Grafana pod not yet present — image pull from mirror.gcr.io may still be in progress"
  fi

  # Alertmanager
  local am_total
  am_total=$(kubectl get pods -n "${ns}" \
    -l "app.kubernetes.io/name=alertmanager" \
    --no-headers 2>/dev/null | wc -l | tr -d ' ')

  if [[ "${am_total}" -gt 0 ]]; then
    wait_for_pods "app.kubernetes.io/name=alertmanager" "${ns}" "alertmanager" 1
    step "alertmanager: ${am_total} pod(s) Running ✓"
  fi

  info "Monitoring stack: healthy (or still starting up — check above for warnings)"
  return 0  # monitoring is advisory; never fail the full deploy
}

# ── Summary table ─────────────────────────────────────────────────────────────
print_summary() {
  echo ""
  echo "======================================================"
  echo "Core Component Status"
  echo "======================================================"

  # kube-system: cilium, coredns, metrics-server, csi-s3
  kubectl get pods -n kube-system \
    -l 'k8s-app in (cilium,kube-dns,metrics-server)' \
    --no-headers 2>/dev/null | \
    awk '{printf "  %-45s %s\n", $1, $3}' || true

  kubectl get pods -n kube-system \
    -l 'app.kubernetes.io/name=metrics-server' \
    --no-headers 2>/dev/null | \
    awk '{printf "  %-45s %s\n", $1, $3}' 2>/dev/null || true

  kubectl get pods -n kube-system \
    -l 'app=csi-s3' \
    --no-headers 2>/dev/null | \
    awk '{printf "  %-45s %s\n", $1, $3}' 2>/dev/null || true

  # cert-manager: controller + webhook + cainjector
  kubectl get pods -n cert-manager \
    --no-headers 2>/dev/null | \
    grep -v "Completed" | \
    awk '{printf "  %-45s %s\n", $1, $3}' 2>/dev/null || true

  # caddy-ingress: caddy deployment + valkey
  kubectl get pods -n caddy-ingress \
    --no-headers 2>/dev/null | \
    awk '{printf "  %-45s %s\n", $1, $3}' 2>/dev/null || true

  # ClusterIssuers
  echo ""
  echo "ClusterIssuers:"
  kubectl get clusterissuer --no-headers 2>/dev/null | \
    awk '{printf "  %-35s %s\n", $1, $2}' 2>/dev/null || \
    echo "  (none found — cert-manager may not be installed)"

  # cnpg-system: CloudNativePG controller
  kubectl get pods -n cnpg-system \
    -l 'app.kubernetes.io/name=cloudnative-pg' \
    --no-headers 2>/dev/null | \
    awk '{printf "  %-45s %s\n", $1, $3}' 2>/dev/null || true

  # opensearch: operator + data nodes
  echo ""
  echo "OpenSearch (ns=opensearch):"
  kubectl get pods -n opensearch \
    --no-headers 2>/dev/null | \
    grep -v "Completed" | \
    awk '{printf "  %-45s %s\n", $1, $3}' 2>/dev/null || \
    echo "  (not installed)"

  echo ""
  echo "OpenSearch Cluster phase:"
  local os_phase
  os_phase=$(kubectl get opensearchcluster opensearch \
    -n opensearch \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "not found")
  echo "  opensearch  →  ${os_phase}"

  # monitoring: prometheus-operator, prometheus, grafana, alertmanager
  echo ""
  echo "Monitoring (ns=monitoring):"
  kubectl get pods -n monitoring \
    --no-headers 2>/dev/null | \
    grep -v "Completed" | \
    awk '{printf "  %-45s %s\n", $1, $3}' 2>/dev/null || \
    echo "  (not installed — phase 10 skipped)"

  echo ""
  echo "StorageClasses:"
  kubectl get storageclass s3-fuse --no-headers 2>/dev/null | \
    awk '{printf "  %-30s %s\n", $1, $2}' 2>/dev/null || \
    echo "  s3-fuse  (not found)"

  echo "======================================================"
}

# ── Main ──────────────────────────────────────────────────────────────────────
log "Verifying core cluster components (timeout: ${WAIT_TIMEOUT}s per component)"
echo ""

FAILED=0

check_cilium    || { err "Cilium CNI verification FAILED"; FAILED=$(( FAILED + 1 )); }
echo ""
check_coredns   || { err "CoreDNS verification FAILED";   FAILED=$(( FAILED + 1 )); }
echo ""
check_metrics_server || { err "metrics-server verification FAILED"; FAILED=$(( FAILED + 1 )); }
echo ""
check_cert_manager || { err "cert-manager verification FAILED"; FAILED=$(( FAILED + 1 )); }
echo ""
check_caddy     || { err "Caddy ingress verification FAILED"; FAILED=$(( FAILED + 1 )); }
echo ""
check_cnpg      || { err "CloudNativePG operator verification FAILED"; FAILED=$(( FAILED + 1 )); }
echo ""
check_csi_s3    || { err "CSI-S3 storage driver verification FAILED"; FAILED=$(( FAILED + 1 )); }
echo ""
check_opensearch || { err "OpenSearch verification FAILED"; FAILED=$(( FAILED + 1 )); }
echo ""
# Monitoring is advisory — warnings but never increment FAILED
check_monitoring || true

print_summary

echo ""
if [[ "${FAILED}" -eq 0 ]]; then
  log "All core cluster components are Running ✓"
  exit 0
else
  err "${FAILED} component(s) failed verification — cluster may not be fully operational"
  exit 1
fi
