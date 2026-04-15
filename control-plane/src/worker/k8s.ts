/**
 * Kubernetes client — singleton using in-cluster config (service account) when
 * running as a pod, falling back to ~/.kube/config for local development.
 *
 * Uses @kubernetes/client-node v1.4 which changed to request-object params
 * (breaking change from v0.x positional args).
 */

import * as k8s from '@kubernetes/client-node';
import { Writable } from 'stream';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { randomBytes as _randomBytes } from 'crypto';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// KubeConfig singleton
// ---------------------------------------------------------------------------
let _kc: k8s.KubeConfig | undefined;

export function getKubeConfig(): k8s.KubeConfig {
  if (_kc) return _kc;
  _kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    // Running inside a cluster — use mounted service account token + CA cert.
    _kc.loadFromCluster();
  } else {
    // Local development — use KUBECONFIG env var or ~/.kube/config.
    _kc.loadFromDefault();
  }
  return _kc;
}

// ---------------------------------------------------------------------------
// API client factories
// ---------------------------------------------------------------------------
export const appsV1Api  = () => getKubeConfig().makeApiClient(k8s.AppsV1Api);
export const coreV1Api  = () => getKubeConfig().makeApiClient(k8s.CoreV1Api);

// Generic object API — handles any Kubernetes resource via GVK + metadata.
// Used for apply-or-patch and delete operations.
export const objectApi = () =>
  k8s.KubernetesObjectApi.makeApiClient(getKubeConfig());

// ---------------------------------------------------------------------------
// readSecretField — read one stringData/data field from an existing Secret.
// Returns null if the secret or field does not exist (e.g. first-time run).
// ---------------------------------------------------------------------------
export async function readSecretField(
  namespace: string,
  secretName: string,
  field: string,
): Promise<string | null> {
  try {
    const secret = await coreV1Api().readNamespacedSecret({ name: secretName, namespace });
    const raw = secret.data?.[field];
    if (raw) return Buffer.from(raw, 'base64').toString('utf-8');
    return null;
  } catch {
    return null; // secret not found
  }
}

// ---------------------------------------------------------------------------
// forceDeleteNamespace — deletes a namespace and force-clears its finalizers
// if it gets stuck in Terminating (e.g. due to metrics API discovery failures).
// ---------------------------------------------------------------------------
export async function forceDeleteNamespace(name: string): Promise<void> {
  const api = coreV1Api();

  // Issue the delete first
  try {
    await api.deleteNamespace({ name });
  } catch (err: unknown) {
    // 404 = already gone, that's fine
    if (!isApiException(err, 404)) throw err;
    return;
  }

  // Poll for up to 60s; if still Terminating, clear finalizers via /finalize
  for (let i = 0; i < 12; i++) {
    await sleep(5_000);
    try {
      const ns = await api.readNamespace({ name });
      if (ns.status?.phase !== 'Terminating') return;
    } catch (err: unknown) {
      if (isApiException(err, 404)) return; // gone
      throw err;
    }
  }

  // Still stuck — clear finalizers via the /finalize subresource (raw HTTP PUT)
  console.log(`[k8s] Namespace ${name} stuck in Terminating — force-clearing finalizers`);
  try {
    const kc = getKubeConfig();
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new Error('No current cluster in kubeconfig');

    const body = JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name }, spec: { finalizers: [] } });
    const url = `${cluster.server}/api/v1/namespaces/${name}/finalize`;

    // Get bearer token — from user config or in-cluster service account file
    const { readFile } = await import('fs/promises');
    const user = kc.getCurrentUser();
    let token = user?.token ?? '';
    if (!token) {
      try { token = (await readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8')).trim(); } catch { /* not in-cluster */ }
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const { default: https } = await import('https');
    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname,
        method: 'PUT',
        headers,
        rejectUnauthorized: false,
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch {
    console.warn(`[k8s] Could not clear finalizers for namespace ${name}`);
  }
}

// ---------------------------------------------------------------------------
// applyObject — idempotent create-or-patch for any K8s resource.
//
// Accepts any plain object with apiVersion/kind/metadata + extra fields like
// spec, data, stringData, type. The 'as k8s.KubernetesObject' cast is safe
// because KubernetesObjectApi serialises the full object body.
// ---------------------------------------------------------------------------
export async function applyObject(spec: Record<string, unknown>): Promise<void> {
  const api = objectApi();
  const k8sSpec = spec as k8s.KubernetesObject;
  try {
    await api.create(k8sSpec);
  } catch (err: unknown) {
    if (isApiException(err, 409)) {
      // Resource already exists — patch with strategic merge (K8s default).
      await api.patch(
        k8sSpec,
        undefined,
        undefined,
        'control-plane-worker',
        undefined,
        k8s.PatchStrategy.StrategicMergePatch,
      );
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// deleteObject — idempotent delete (ignores 404).
// ---------------------------------------------------------------------------
export async function deleteObject(spec: Record<string, unknown>): Promise<void> {
  const api = objectApi();
  try {
    await api.delete(spec as k8s.KubernetesObject);
  } catch (err: unknown) {
    if (isApiException(err, 404)) return; // already gone — that's fine
    throw err;
  }
}

// ---------------------------------------------------------------------------
// patchDeploymentReplicas — scales a deployment to the given replica count.
// Uses KubernetesObjectApi.patch() with MergePatch strategy so the
// Content-Type header is set correctly (application/merge-patch+json).
// ---------------------------------------------------------------------------
export async function patchDeploymentReplicas(
  namespace: string,
  deploymentName: string,
  replicas: number,
): Promise<void> {
  const api = objectApi();
  const patchSpec = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: deploymentName, namespace },
    spec: { replicas },
  } as k8s.KubernetesObject;

  await api.patch(
    patchSpec,
    undefined,
    undefined,
    'control-plane-worker',
    undefined,
    k8s.PatchStrategy.MergePatch,
  );
}

// ---------------------------------------------------------------------------
// execInPod — runs a command inside a running pod and captures stdout/stderr.
// Equivalent to: kubectl exec -n <ns> <pod> -c <container> -- <cmd...>
// ---------------------------------------------------------------------------
export async function execInPod(
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
): Promise<{ stdout: string; stderr: string }> {
  const exec = new k8s.Exec(getKubeConfig());
  let stdout = '';
  let stderr = '';

  const stdoutStream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      stdout += chunk.toString();
      cb();
    },
  });

  const stderrStream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      stderr += chunk.toString();
      cb();
    },
  });

  await new Promise<void>((resolve, reject) => {
    exec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status: k8s.V1Status) => {
          if (status.status === 'Success') {
            resolve();
          } else {
            reject(
              new Error(
                `exec failed in ${namespace}/${podName}: ${status.message ?? stderr.slice(0, 500)}`,
              ),
            );
          }
        },
      )
      .catch(reject);
  });

  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// waitForDeploymentReady — polls until the deployment has readyReplicas >= 1,
// or the timeout expires. Returns true on success, false on timeout.
//
// Uses @kubernetes/client-node v1.4 request-object API:
//   readNamespacedDeployment({ name, namespace }) → Promise<V1Deployment>
// ---------------------------------------------------------------------------
export async function waitForDeploymentReady(
  namespace: string,
  deploymentName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 10_000;

  while (Date.now() < deadline) {
    try {
      const api = appsV1Api();
      // v1.4 breaking change: request-object params, result is T directly (no .body wrapper)
      const deploy = await api.readNamespacedDeployment({
        name: deploymentName,
        namespace,
      });
      const ready = deploy.status?.readyReplicas ?? 0;
      const desired = deploy.status?.replicas ?? 0;
      if (desired > 0 && ready >= desired) return true;
    } catch {
      // deployment may not exist yet — keep waiting
    }
    await sleep(pollIntervalMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `err` is a @kubernetes/client-node v1.4 ApiException
 * with the given HTTP status code.
 */
function isApiException(err: unknown, code: number): boolean {
  if (typeof err !== 'object' || err === null) return false;
  // ApiException has a numeric .code property (HTTP status code).
  const candidate = err as Record<string, unknown>;
  return typeof candidate.code === 'number' && candidate.code === code;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// kubectlApplyDir — runs `kubectl apply -k` against an existing overlay dir.
//
// Unlike kubectlApplyKustomize (which builds its own temp overlay from a patch
// object), this function is for pre-scaffolded overlays — e.g., the tenant
// overlay written by scaffoldTenantOverlay() in kustomize.ts.
//
// Prerequisites: same as kubectlApplyKustomize (kubectl on $PATH, RBAC).
//
// @param overlayDir - Absolute path to an existing kustomize overlay directory
//                     that contains a kustomization.yaml file.
// ---------------------------------------------------------------------------
export async function kubectlApplyDir(
  overlayDir: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(`kubectl apply -k ${overlayDir}`);
    return { stdout, stderr };
  } catch (err: unknown) {
    // execAsync rejects on non-zero exit; attach kubectl output to the error
    // message so provisioning failures carry actionable diagnostic context.
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail = [e.stderr?.trim(), e.stdout?.trim()].filter(Boolean).join('\n');
    throw new Error(
      `kubectl apply -k ${overlayDir} failed (exit ${e.code ?? 'unknown'})` +
        (detail ? `:\n${detail}` : ''),
    );
  }
}

// ---------------------------------------------------------------------------
// kubectlApplyKustomize — applies a resource patch via `kubectl apply -k`.
//
// Writes the patch object as a JSON file to a temporary kustomize overlay
// directory, generates a minimal kustomization.yaml that references it as a
// resource, runs `kubectl apply -k <dir>`, then cleans up.
//
// JSON is valid YAML and kubectl accepts both formats, so no YAML serializer
// dependency is needed.  kubectl uses 3-way strategic-merge on apply, so
// fields absent from `patch` are preserved on the live resource.
//
// Prerequisites:
//   - kubectl must be on $PATH in the container image (nixpacks: add kubectl
//     to packages; railpack: install via setup command).
//   - The pod's ServiceAccount must have RBAC permission to patch the target
//     resource kind (apps/v1 Deployment in tenant namespace).
//
// @param patch  - A full or partial Kubernetes object with apiVersion, kind,
//                 metadata.name, metadata.namespace, and desired spec fields.
//                 Typically produced by kustomizeDeploymentPatch() in
//                 src/worker/kustomize.ts.
// @param overlayDir - Optional path to write the overlay.  Defaults to a
//                     fresh temporary directory that is deleted after apply.
//                     Pass an explicit path (e.g. /overlays/<org>/<env>) to
//                     persist the overlay for audit / re-apply purposes.
// ---------------------------------------------------------------------------
export async function kubectlApplyKustomize(
  patch: Record<string, unknown>,
  overlayDir?: string,
): Promise<{ stdout: string; stderr: string }> {
  const tmpDir =
    overlayDir ??
    path.join(os.tmpdir(), `kustomize-${_randomBytes(8).toString('hex')}`);
  const isTemp = !overlayDir;

  await mkdir(tmpDir, { recursive: true });

  try {
    // Write the patch as JSON (valid YAML superset; no extra dep required).
    const patchFile = path.join(tmpDir, 'patch.json');
    await writeFile(patchFile, JSON.stringify(patch, null, 2), 'utf8');

    // Minimal kustomization.yaml — treats patch.json as a full resource.
    // kubectl apply -k will 3-way-merge against the live resource using the
    // last-applied-configuration annotation, so absent fields are preserved.
    const kustomizationYaml = [
      'apiVersion: kustomize.config.k8s.io/v1beta1',
      'kind: Kustomization',
      'resources:',
      '  - patch.json',
    ].join('\n') + '\n';
    await writeFile(path.join(tmpDir, 'kustomization.yaml'), kustomizationYaml, 'utf8');

    // Run kubectl apply -k — kubectl resolves in-cluster kubeconfig via the
    // KUBERNETES_SERVICE_HOST env var (same mechanism as getKubeConfig()).
    const { stdout, stderr } = await execAsync(`kubectl apply -k ${tmpDir}`);
    return { stdout, stderr };
  } finally {
    if (isTemp) {
      // Best-effort cleanup; never throws so the apply result is preserved.
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
