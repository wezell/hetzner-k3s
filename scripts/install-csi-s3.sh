#!/usr/bin/env bash
# scripts/install-csi-s3.sh — Install CSI-S3 driver (geesefs) + s3-fuse StorageClass
#
# Provides Wasabi-backed S3-mounted volumes for dotCMS shared assets storage.
# One PVC per tenant environment is provisioned by tenant-add.sh using the
# s3-fuse StorageClass created here.
#
# The CSI-S3 Helm chart is installed with Wasabi credentials from .env.
# The StorageClass is managed separately (not via Helm) to enable pathPattern
# support, which maps PVC namespace/name to an S3 prefix for per-tenant isolation.
#
# Required env vars (sourced from .env):
#   WASABI_ACCESS_KEY, WASABI_SECRET_KEY, WASABI_REGION, WASABI_S3FUSE_BUCKET
#
# Called by deploy.sh phase 8. Must be idempotent.

set -euo pipefail

CSI_S3_NAMESPACE="kube-system"
CSI_S3_HELM_RELEASE="csi-s3"
CSI_S3_VERSION="0.42.2"
WAIT_TIMEOUT=300   # seconds

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}WARN:${NC} $*"; }
err()  { echo -e "${RED}ERROR:${NC} $*" >&2; }
info() { echo "    $*"; }

# ── Required env var validation ───────────────────────────────────────────────
for var in WASABI_ACCESS_KEY WASABI_SECRET_KEY WASABI_REGION WASABI_S3FUSE_BUCKET; do
  if [[ -z "${!var:-}" ]]; then
    err "Required env var not set: ${var}"
    err "Source .env before running this script"
    exit 1
  fi
done

# ── Check if CSI-S3 is already deployed ───────────────────────────────────────
csi_s3_installed() {
  helm status "${CSI_S3_HELM_RELEASE}" -n "${CSI_S3_NAMESPACE}" >/dev/null 2>&1
}

# ── Install CSI-S3 via Helm ───────────────────────────────────────────────────
install_csi_s3() {
  log "Installing CSI-S3 (geesefs) ${CSI_S3_VERSION} via Helm"

  helm install "${CSI_S3_HELM_RELEASE}" csi-s3/csi-s3 \
    --version "${CSI_S3_VERSION}" \
    --namespace "${CSI_S3_NAMESPACE}" \
    --set secret.accessKey="${WASABI_ACCESS_KEY}" \
    --set secret.secretKey="${WASABI_SECRET_KEY}" \
    --set "secret.endpoint=https://s3.${WASABI_REGION}.wasabisys.com" \
    --set secret.region="${WASABI_REGION}" \
    --set storageClass.create=false \
    --set kubeletPath=/var/lib/kubelet \
    --set "provisionerArguments[0]=--extra-create-metadata=true" \
    --set node.additionalHostPathMounts[0].name=geesefs-cache \
    --set node.additionalHostPathMounts[0].hostPath=/var/lib/geesefs-cache \
    --set node.additionalHostPathMounts[0].mountPath=/var/lib/geesefs-cache \
    --set "node.additionalHostPathMounts[0].type=DirectoryOrCreate" \
    --set node.additionalHostPathMounts[1].name=dbus-socket \
    --set node.additionalHostPathMounts[1].hostPath=/run/dbus \
    --set node.additionalHostPathMounts[1].mountPath=/run/dbus \
    --set "node.additionalHostPathMounts[1].type=Directory" \
    --wait=false

  info "CSI-S3 Helm release created"
}

# ── Create s3-fuse StorageClass ───────────────────────────────────────────────
# Managed separately from Helm to enable pathPattern, which the chart does not
# expose as a values key. pathPattern maps PVC namespace/name → S3 key prefix,
# providing per-tenant storage isolation within the shared bucket.
apply_storage_class() {
  log "Applying s3-fuse StorageClass (pathPattern-based per-tenant isolation)"

  kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: s3-fuse
  labels:
    app.kubernetes.io/managed-by: deploy.sh
    app.kubernetes.io/component: csi-s3
provisioner: ru.yandex.s3.csi
reclaimPolicy: Retain
volumeBindingMode: Immediate
parameters:
  bucket: "${WASABI_S3FUSE_BUCKET}"
  mounter: geesefs
  options: "--cache /var/lib/geesefs-cache --memory-limit 5120 --dir-mode 0777 --file-mode 0666"
  pathPattern: "\${pvc.metadata.namespace}/\${pvc.metadata.name}"
  csi.storage.k8s.io/provisioner-secret-name: csi-s3-secret
  csi.storage.k8s.io/provisioner-secret-namespace: kube-system
  csi.storage.k8s.io/controller-publish-secret-name: csi-s3-secret
  csi.storage.k8s.io/controller-publish-secret-namespace: kube-system
  csi.storage.k8s.io/node-stage-secret-name: csi-s3-secret
  csi.storage.k8s.io/node-stage-secret-namespace: kube-system
  csi.storage.k8s.io/node-publish-secret-name: csi-s3-secret
  csi.storage.k8s.io/node-publish-secret-namespace: kube-system
EOF

  info "s3-fuse StorageClass applied"
}

# ── Wait for CSI-S3 DaemonSet pods to reach Running ──────────────────────────
wait_for_node_pods() {
  log "Waiting for CSI-S3 node DaemonSet pods to be Running (timeout: ${WAIT_TIMEOUT}s)..."

  local deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  local ready=false

  # CSI-S3 deploys a DaemonSet (node plugin) and a Deployment (provisioner)
  # Both must be Running before the StorageClass can provision volumes.

  while [[ $(date +%s) -lt ${deadline} ]]; do
    # Check csi-s3 pods in kube-system (DaemonSet + Deployment)
    local total not_running

    total=$(kubectl get pods -n "${CSI_S3_NAMESPACE}" \
      -l "app=csi-s3" \
      --no-headers 2>/dev/null | wc -l | tr -d ' ')

    not_running=$(kubectl get pods -n "${CSI_S3_NAMESPACE}" \
      -l "app=csi-s3" \
      --no-headers 2>/dev/null \
      | grep -v -E '\bRunning\b' \
      | wc -l | tr -d ' ')

    if [[ "${total}" -gt 0 && "${not_running}" -eq 0 ]]; then
      if kubectl wait pod \
          -n "${CSI_S3_NAMESPACE}" \
          -l "app=csi-s3" \
          --for=condition=Ready \
          --timeout=10s >/dev/null 2>&1; then
        ready=true
        break
      fi
    fi

    local running=$(( total - not_running ))
    info "  CSI-S3 pods: ${running}/${total} Running (waiting...)"
    sleep 10
  done

  if [[ "${ready}" != "true" ]]; then
    err "CSI-S3 pods did not reach Running state within ${WAIT_TIMEOUT}s"
    kubectl get pods -n "${CSI_S3_NAMESPACE}" -l "app=csi-s3" 2>/dev/null || true
    exit 1
  fi

  local count
  count=$(kubectl get pods -n "${CSI_S3_NAMESPACE}" -l "app=csi-s3" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  info "CSI-S3: ${count} pod(s) Running and Ready"
}

# ── Verify StorageClass is registered ────────────────────────────────────────
verify_storage_class() {
  log "Verifying s3-fuse StorageClass is registered"

  local deadline=$(( $(date +%s) + 60 ))
  local found=false

  while [[ $(date +%s) -lt ${deadline} ]]; do
    if kubectl get storageclass s3-fuse >/dev/null 2>&1; then
      found=true
      break
    fi
    sleep 5
  done

  if [[ "${found}" != "true" ]]; then
    err "s3-fuse StorageClass not found after apply — check kubectl apply output above"
    exit 1
  fi

  local provisioner
  provisioner=$(kubectl get storageclass s3-fuse -o jsonpath='{.provisioner}' 2>/dev/null)
  info "s3-fuse StorageClass registered (provisioner: ${provisioner})"
}

# ── Readiness probe: test PVC bind against Wasabi ────────────────────────────
# Creates a 1Gi PVC in kube-system using the s3-fuse StorageClass, waits for
# it to reach Bound state (proving the CSI driver can provision against Wasabi),
# then deletes the PVC. Fails the deploy if the PVC does not bind within timeout.
#
# This is the authoritative "cluster is ready to serve tenant volumes" gate.
# Without a successful bind the cluster would pass structural checks yet fail
# at first tenant-add.sh run when the real assets PVC is requested.
probe_pvc_bind() {
  local probe_ns="kube-system"
  local probe_name="csi-s3-probe-$(date +%s)"
  local bind_timeout=120  # seconds — geesefs init + S3 handshake can take ~30-60s
  local bound=false

  log "Readiness probe: creating test PVC '${probe_name}' against s3-fuse StorageClass..."

  # Create the probe PVC
  kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${probe_name}
  namespace: ${probe_ns}
  labels:
    app.kubernetes.io/managed-by: deploy.sh
    app.kubernetes.io/component: csi-s3-probe
  annotations:
    deploy.sh/probe: "true"
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: s3-fuse
  resources:
    requests:
      storage: 1Gi
EOF

  info "Test PVC created — waiting for Bound state (timeout: ${bind_timeout}s)..."

  # Poll for Bound phase
  local deadline=$(( $(date +%s) + bind_timeout ))
  while [[ $(date +%s) -lt ${deadline} ]]; do
    local phase
    phase=$(kubectl get pvc "${probe_name}" -n "${probe_ns}" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")

    if [[ "${phase}" == "Bound" ]]; then
      bound=true
      break
    fi

    # Surface any provisioner events to aid diagnosis
    local last_event
    last_event=$(kubectl get events -n "${probe_ns}" \
      --field-selector "involvedObject.name=${probe_name}" \
      --sort-by='.lastTimestamp' \
      -o jsonpath='{.items[-1:].message}' 2>/dev/null || echo "")

    info "  PVC phase: ${phase:-Pending}${last_event:+ — ${last_event}} (waiting...)"
    sleep 10
  done

  # Always clean up the probe PVC before reporting result
  log "Cleaning up probe PVC '${probe_name}'..."
  kubectl delete pvc "${probe_name}" -n "${probe_ns}" --ignore-not-found=true \
    --timeout=30s >/dev/null 2>&1 || \
    warn "Probe PVC deletion timed out — orphan PVC '${probe_name}' in ${probe_ns}"

  if [[ "${bound}" != "true" ]]; then
    err "CSI-S3 readiness probe FAILED: test PVC did not reach Bound state within ${bind_timeout}s"
    err "Check CSI-S3 controller logs: kubectl logs -n ${CSI_S3_NAMESPACE} -l app=csi-s3"
    err "Verify Wasabi credentials and bucket '${WASABI_S3FUSE_BUCKET}' exists in region '${WASABI_REGION}'"
    exit 1
  fi

  info "Readiness probe PASSED — Wasabi-backed PVC provisioning confirmed"
}

# ── Main ──────────────────────────────────────────────────────────────────────
if csi_s3_installed; then
  info "CSI-S3 Helm release '${CSI_S3_HELM_RELEASE}' already present in ${CSI_S3_NAMESPACE}"
else
  install_csi_s3
fi

apply_storage_class
wait_for_node_pods
verify_storage_class
probe_pvc_bind

log "CSI-S3 storage phase complete"
