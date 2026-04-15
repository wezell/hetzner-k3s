/**
 * Kustomize overlay patch generator and tenant overlay scaffolding.
 *
 * Produces a Kubernetes strategic-merge-patch Deployment object derived
 * from a customer_env database record.  The patch targets only the fields
 * that operators can tune per-environment so that the base template
 * (defined in templates.ts) remains the authoritative source for everything
 * else.
 *
 * Configurable fields covered by the patch:
 *   - spec.replicas                    ← env.replicas
 *   - containers[dotcms].image         ← env.image
 *   - containers[dotcms].resources     ← env.{cpu,memory}_{req,limit}
 *   - containers[dotcms].env           ← env.env_vars (merged by name key)
 *
 * Strategic-merge-patch semantics for the `env` array:
 *   Kubernetes uses the `name` field as the strategic merge key for container
 *   env vars.  Entries in this patch are merged with (or override) entries
 *   already on the pod template from the base Deployment.  To remove a var
 *   use a $patch: delete directive — that is out of scope here (operator can
 *   do so manually).
 *
 * Overlay scaffolding (scaffoldTenantOverlay):
 *   Creates kustomize/tenants/{instance}/ and writes a kustomization.yaml
 *   referencing kustomize/dotcms-base with tenant-specific namespace, image
 *   override, and strategic-merge patches for all per-tenant fields.
 *
 * Usage:
 *   const patch = kustomizeDeploymentPatch(env);
 *   await patchDeployment(env.org_key, instanceName(env), patch);
 *
 *   const overlayDir = await scaffoldTenantOverlay(env);
 *   // → kustomize/tenants/{instance}/kustomization.yaml written
 */

import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import type { CustomerEnv } from '@/db/types';
import { instanceName } from '@/db/types';

/** Opaque K8s object — same alias used throughout templates.ts */
type K8sSpec = Record<string, unknown>;

/**
 * Normalize a Kubernetes resource quantity string to the correct case.
 *
 * Kubernetes accepts specific suffixes — binary IEC (Ki/Mi/Gi/Ti/Pi/Ei) must
 * have an uppercase prefix; plain SI suffixes G/T/P/E must also be uppercase.
 * Only 'm' (milli) and 'k' are accepted lowercase.
 *
 * Examples: "4gi" → "4Gi", "512mi" → "512Mi", "500m" → "500m" (unchanged)
 */
export function normalizeQuantity(q: string | null | undefined): string {
  if (!q) return '';
  const s = q.trim();
  const match = s.match(/^([+-]?[0-9.]+)([a-zA-Z]*)$/);
  if (!match) return s;
  const [, num, suffix] = match;
  if (!suffix) return s;
  const lower = suffix.toLowerCase();
  // IEC binary (must be uppercase prefix + lowercase i)
  const binaryMap: Record<string, string> = {
    ki: 'Ki', mi: 'Mi', gi: 'Gi', ti: 'Ti', pi: 'Pi', ei: 'Ei',
  };
  if (binaryMap[lower]) return num + binaryMap[lower];
  // SI — 'k' and 'm' valid lowercase; G/T/P/E require uppercase
  const siMap: Record<string, string> = {
    k: 'k', m: 'm', g: 'G', t: 'T', p: 'P', e: 'E',
  };
  if (siMap[lower]) return num + siMap[lower];
  return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a strategic-merge-patch Deployment object from `env`.
 *
 * The result can be passed to:
 *   - `applyObject()` (idempotent upsert — safe on any reconcile cycle)
 *   - `patchDeployment()` (explicit patch with MergePatch / StrategicMergePatch)
 *   - `kubectl patch --type=strategic-merge-patch -f <(echo $JSON)`
 */
export function kustomizeDeploymentPatch(env: CustomerEnv): K8sSpec {
  const instance = instanceName(env);
  const tenantId = env.org_key;

  // ------------------------------------------------------------------
  // Resource limits — cpu_limit is optional in the schema; omit the key
  // entirely when absent so the base template value is preserved.
  // ------------------------------------------------------------------
  const limits: Record<string, string> = {
    memory: normalizeQuantity(env.memory_limit),
  };
  if (env.cpu_limit) {
    limits.cpu = normalizeQuantity(env.cpu_limit);
  }

  // ------------------------------------------------------------------
  // Extra env vars — env_vars is a JSONB column typed as
  // Record<string, string>.  Convert to the K8s {name, value} array
  // format so they merge cleanly with the base template's env list.
  // ------------------------------------------------------------------
  const extraEnv: Array<{ name: string; value: string }> = Object.entries(
    env.env_vars ?? {},
  ).map(([name, value]) => ({ name, value }));

  // ------------------------------------------------------------------
  // Strategic-merge-patch Deployment
  //
  // Only include fields that are derived from customer_env.  The K8s
  // server merges this with the live resource spec; fields absent here
  // are left untouched.
  // ------------------------------------------------------------------
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: instance,
      namespace: tenantId,
    },
    spec: {
      replicas: env.replicas,
      template: {
        spec: {
          containers: [
            {
              // Strategic merge key — must match the container name in the
              // base Deployment (dotcmsDeploymentSpec uses "dotcms").
              name: 'dotcms',
              image: env.image,
              resources: {
                requests: {
                  cpu: normalizeQuantity(env.cpu_req),
                  memory: normalizeQuantity(env.memory_req),
                },
                limits,
              },
              // Empty array when env_vars is empty: no extra vars injected,
              // base template env list is preserved as-is.
              ...(extraEnv.length > 0 ? { env: extraEnv } : {}),
            },
          ],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Derived patch helpers
// ---------------------------------------------------------------------------

/**
 * Minimal patch that only updates replica count and image.
 *
 * Useful for stop/restart operations where resource tuning is not needed.
 */
export function replicaImagePatch(
  env: Pick<CustomerEnv, 'org_key' | 'env_key' | 'replicas' | 'image'>,
): K8sSpec {
  const instance = instanceName(env);
  const tenantId = env.org_key;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: instance, namespace: tenantId },
    spec: {
      replicas: env.replicas,
      template: {
        spec: {
          containers: [{ name: 'dotcms', image: env.image }],
        },
      },
    },
  };
}

/**
 * Scale-to-zero patch for the stop lifecycle action.
 *
 * Sets replicas to 0 while preserving image and resource config.
 */
export function stopPatch(
  env: Pick<CustomerEnv, 'org_key' | 'env_key'>,
): K8sSpec {
  const instance = instanceName(env);
  const tenantId = env.org_key;

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: instance, namespace: tenantId },
    spec: { replicas: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tenant overlay scaffolding
// ---------------------------------------------------------------------------

/**
 * Default root directory for tenant Kustomize overlays.
 *
 * Resolved at module load time from KUSTOMIZE_OVERLAY_ROOT env var or
 * {cwd}/kustomize/tenants.  The app bundles the kustomize/ tree alongside
 * the Next.js build so kubectl apply -k can resolve ../../dotcms-base from
 * the overlay directory.
 */
export const DEFAULT_OVERLAY_ROOT: string =
  process.env.KUSTOMIZE_OVERLAY_ROOT ??
  path.join(process.cwd(), 'kustomize', 'tenants');

/**
 * Parse a Docker image reference into the Kustomize `images` transformer
 * fields: `newName` (registry + repo, no tag) and `newTag`.
 *
 * Examples:
 *   "dotcms/dotcms:latest"                     → { newName: "dotcms/dotcms",                  newTag: "latest" }
 *   "mirror.gcr.io/dotcms/dotcms:trunk-latest" → { newName: "mirror.gcr.io/dotcms/dotcms",    newTag: "trunk-latest" }
 *   "dotcms/dotcms"                             → { newName: "dotcms/dotcms",                  newTag: "latest" }
 */
export function parseImage(image: string): { newName: string; newTag: string } {
  const colonIdx = image.lastIndexOf(':');
  if (colonIdx === -1) {
    return { newName: image, newTag: 'latest' };
  }
  return {
    newName: image.substring(0, colonIdx),
    newTag: image.substring(colonIdx + 1),
  };
}

/**
 * Build YAML lines for operator-defined environment variable overrides.
 *
 * Converts the `env_vars` JSONB column (Record<string, string>) into the
 * indented YAML list entries expected by the strategic-merge-patch container
 * env section (18-space indent).  Returns an empty string when `envVars` is
 * null, undefined, or empty so the caller's template interpolation is
 * transparent — no trailing whitespace or extra blank lines are emitted.
 *
 * Output example for { MY_FLAG: "true", LOG_LEVEL: "debug" }:
 *   ```
 *                   - name: MY_FLAG
 *                     value: "true"
 *                   - name: LOG_LEVEL
 *                     value: "debug"
 *   ```
 *   (followed by a trailing newline so the next template line is separate)
 */
export function buildExtraEnvVarsYaml(
  envVars: Record<string, string> | null | undefined,
): string {
  const entries = Object.entries(envVars ?? {});
  if (entries.length === 0) return '';
  const lines = entries.map(
    ([name, value]) =>
      `                  - name: ${name}\n                    value: "${value}"`,
  );
  return lines.join('\n') + '\n';
}

/**
 * Generate the content of the kustomization.yaml for a tenant overlay.
 *
 * The output mirrors what generate-tenant-overlay.sh produces:
 *   - namespace set to the tenant namespace (org_key)
 *   - resources: [../../dotcms-base] — references the shared base layer
 *   - images: directive overrides the dotcms/dotcms base image
 *   - JSON patches rename all resources from generic base names to {instance}
 *   - Strategic-merge patches inject per-tenant Deployment config:
 *       selector labels, container resources, DB/OS secret refs, PVC name,
 *       pod anti-affinity with instance label
 *   - Operator-defined env var overrides from env.env_vars appended after
 *     the required env vars (DB/OS credentials, cluster ID)
 *   - Service selector patches wire ClusterIP + headless services to pods
 *   - PDB selector patch targets the renamed deployment pods
 *
 * This function is pure (no I/O) so it can be unit-tested without mocking.
 */
export function generateOverlayKustomization(env: CustomerEnv): string {
  const instance = instanceName(env);
  const namespace = env.org_key;
  const { newName, newTag } = parseImage(env.image);

  const cpuLimitLine = env.cpu_limit
    ? `\n                    cpu: "${normalizeQuantity(env.cpu_limit)}"`
    : '';

  // Operator-defined env var overrides — appended after the required vars.
  // Empty string when env_vars is null/empty (no visible diff in the output).
  const extraEnvVarsBlock = buildExtraEnvVarsYaml(env.env_vars);

  return `# Generated by control-plane provisioner — do not edit manually
# Tenant: ${namespace}  Environment: ${env.env_key}  Instance: ${instance}
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: ${namespace}

resources:
  - ../../dotcms-base

images:
  - name: dotcms/dotcms
    newName: ${newName}
    newTag: ${newTag}

patches:
  # ── Rename resources (JSON patch) ──────────────────────────────────────────
  - target: {kind: Deployment, name: dotcms}
    patch: |
      - {op: replace, path: /metadata/name, value: ${instance}}
  - target: {kind: Service, name: dotcms}
    patch: |
      - {op: replace, path: /metadata/name, value: ${instance}}
  - target: {kind: Service, name: dotcms-hl}
    patch: |
      - {op: replace, path: /metadata/name, value: ${instance}-hl}
  - target: {kind: HorizontalPodAutoscaler, name: dotcms}
    patch: |
      - {op: replace, path: /metadata/name, value: ${instance}}
      - {op: replace, path: /spec/scaleTargetRef/name, value: ${instance}}
  - target: {kind: PodDisruptionBudget, name: dotcms}
    patch: |
      - {op: replace, path: /metadata/name, value: ${instance}}

  # ── Instance-specific Deployment config (strategic merge) ──────────────────
  - target: {kind: Deployment, name: dotcms}
    patch: |-
      apiVersion: apps/v1
      kind: Deployment
      metadata:
        name: dotcms
      spec:
        replicas: ${env.replicas}
        template:
          metadata:
            labels:
              instance: ${instance}
              botcms.cloud/tenant: ${namespace}
              botcms.cloud/instance: ${instance}
          spec:
            containers:
              - name: dotcms
                resources:
                  requests:
                    cpu: "${normalizeQuantity(env.cpu_req)}"
                    memory: "${normalizeQuantity(env.memory_req)}"
                  limits:
                    memory: "${normalizeQuantity(env.memory_limit)}"${cpuLimitLine}
                env:
                  - name: DOT_DOTCMS_CLUSTER_ID
                    value: ${instance}
                  - name: DB_BASE_URL
                    value: "jdbc:postgresql://postgres-rw.postgres.svc.cluster.local:5432/${instance}"
                  - name: DB_USERNAME
                    valueFrom:
                      secretKeyRef:
                        name: ${instance}-postgres
                        key: username
                  - name: DB_PASSWORD
                    valueFrom:
                      secretKeyRef:
                        name: ${instance}-postgres
                        key: password
                  - name: DOT_ES_AUTH_BASIC_USER
                    valueFrom:
                      secretKeyRef:
                        name: ${instance}-os-creds
                        key: username
                  - name: DOT_ES_AUTH_BASIC_PASSWORD
                    valueFrom:
                      secretKeyRef:
                        name: ${instance}-os-creds
                        key: password
${extraEnvVarsBlock}                volumeMounts:
                  - name: assets
                    mountPath: /data/shared
            volumes:
              - name: assets
                persistentVolumeClaim:
                  claimName: ${instance}-assets
            affinity:
              podAntiAffinity:
                requiredDuringSchedulingIgnoredDuringExecution:
                  - labelSelector:
                      matchExpressions:
                        - key: instance
                          operator: In
                          values: [${instance}]
                    topologyKey: kubernetes.io/hostname

  # ── Service selectors ───────────────────────────────────────────────────────
  - target: {kind: Service, name: dotcms}
    patch: |-
      apiVersion: v1
      kind: Service
      metadata:
        name: dotcms
      spec:
        selector:
          instance: ${instance}

  - target: {kind: Service, name: dotcms-hl}
    patch: |-
      apiVersion: v1
      kind: Service
      metadata:
        name: dotcms-hl
      spec:
        selector:
          instance: ${instance}

  # ── PDB selector ────────────────────────────────────────────────────────────
  - target: {kind: PodDisruptionBudget, name: dotcms}
    patch: |-
      apiVersion: policy/v1
      kind: PodDisruptionBudget
      metadata:
        name: dotcms
      spec:
        selector:
          matchLabels:
            instance: ${instance}
`;
}

/**
 * Scaffold a Kustomize tenant overlay directory.
 *
 * Creates `{overlayRoot}/{instance}/` (where instance = org_key-env_key) and
 * writes a `kustomization.yaml` that:
 *   - Sets `namespace: {org_key}` (the tenant K8s namespace)
 *   - References `../../dotcms-base` as the shared base layer
 *   - Overrides the container image via Kustomize images transformer
 *   - Patches all resources to use instance-specific names and per-tenant config
 *
 * The generated overlay is equivalent to what `generate-tenant-overlay.sh`
 * produces and is immediately usable with `kubectl apply -k {overlayDir}`.
 *
 * @param env         Customer environment record from the database
 * @param overlayRoot Optional root directory for tenant overlays.
 *                    Defaults to KUSTOMIZE_OVERLAY_ROOT env var or
 *                    {cwd}/kustomize/tenants.
 * @returns Absolute path to the created/updated overlay directory
 */
export async function scaffoldTenantOverlay(
  env: CustomerEnv,
  overlayRoot?: string,
): Promise<string> {
  const instance = instanceName(env);
  const root = overlayRoot ?? DEFAULT_OVERLAY_ROOT;
  const overlayDir = path.join(root, instance);

  await mkdir(overlayDir, { recursive: true });

  const content = generateOverlayKustomization(env);
  await writeFile(path.join(overlayDir, 'kustomization.yaml'), content, 'utf8');

  return overlayDir;
}
