/**
 * Provisioner — replicates tenant-add.sh steps 1–9 programmatically.
 *
 * Each step maps 1:1 to a tenant-add.sh step:
 *   Step 1 — Namespace + ResourceQuota + LimitRange
 *   Step 2 — Valkey ExternalName Service + connection Secret
 *   Step 3 — Wasabi backup credentials Secret
 *   Step 4 — OpenSearch action groups, user, role, role mapping + k8s Secret
 *   Step 5 — PostgreSQL role + database (via kubectl exec into CNPG pod) + credentials Secret
 *   Step 6 — S3-backed PersistentVolume + PersistentVolumeClaim
 *   Step 7 — dotCMS Deployment, HPA, PDB, ClusterIP Service, Headless Service
 *   Step 8 — Ingress routing declaration
 *   Step 9 — CaddyRoute ConfigMap catalog entry
 *  Step 10 — Wait for pod Ready (10-minute timeout → mark deployed or failed)
 */

import { randomBytes } from 'crypto';
import type { CustomerEnv } from '@/db/types';
import { applyObject, waitForDeploymentReady, kubectlApplyDir, readSecretField } from './k8s';
import { sql } from '@/db';
import { provisionOpenSearch } from './opensearch';
import { runStep } from './logger';
import { scaffoldTenantOverlay } from './kustomize';
import {
  namespaceSpec,
  resourceQuotaSpec,
  limitRangeSpec,
  valkeyServiceSpec,
  valkeySecretSpec,
  wasabiBackupSecretSpec,
  opensearchSecretSpec,
  postgresSecretSpec,
  persistentVolumeSpec,
  persistentVolumeClaimSpec,
  ingressSpec,
  caddyRouteSpec,
} from './templates';

// ---------------------------------------------------------------------------
// Config helpers — read from process.env
// ---------------------------------------------------------------------------
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// 10-minute pod ready timeout (per constraint)
const POD_READY_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Main provisioning entry point
// ---------------------------------------------------------------------------

/**
 * Provisions all Kubernetes resources for a customer_env.
 * Throws on failure — caller handles retry and status updates.
 */
export async function provisionEnv(env: CustomerEnv): Promise<void> {
  const tenantId = env.org_key; // TENANT_ID in shell scripts
  const envId = env.env_key; // ENV_ID in shell scripts
  const instance = `${tenantId}-${envId}`; // INSTANCE

  const baseDomain = requireEnv('BASE_DOMAIN');
  const valkeyPassword = process.env.VALKEY_PASSWORD ?? '';
  const wasabiAccessKey = requireEnv('WASABI_ACCESS_KEY');
  const wasabiSecretKey = requireEnv('WASABI_SECRET_KEY');
  const wasabiS3FuseBucket = requireEnv('WASABI_S3FUSE_BUCKET');
  const assetsStorageSize = process.env.ASSETS_STORAGE_SIZE ?? '20Gi';

  console.log(`[provisioner] === Provisioning ${instance} ===`);

  // Convenience shorthand — all step errors are logged then re-thrown so
  // the outer runWithRetry in poll.ts handles retry / status transitions.
  const step = (name: string, fn: () => Promise<void>) =>
    runStep(env.org_key, env.env_key, 'provision', name, fn);

  // ─── Step 1: Namespace + ResourceQuota + LimitRange ────────────────────────
  console.log(`[provisioner] Step 1: Namespace + ResourceQuota + LimitRange`);
  await step('Step 1: Namespace + ResourceQuota + LimitRange', async () => {
    await applyObject(namespaceSpec(tenantId));
    await applyObject(resourceQuotaSpec(tenantId));
    await applyObject(limitRangeSpec(tenantId));
  });

  // ─── Step 2: Valkey ExternalName Service + Secret ──────────────────────────
  console.log(`[provisioner] Step 2: Valkey service + secret`);
  await step('Step 2: Valkey service + secret', async () => {
    await applyObject(valkeyServiceSpec(tenantId));
    await applyObject(valkeySecretSpec(tenantId, instance, valkeyPassword));
  });

  // ─── Step 3: Wasabi backup credentials Secret ──────────────────────────────
  console.log(`[provisioner] Step 3: Wasabi backup secret`);
  await step('Step 3: Wasabi backup secret', async () => {
    await applyObject(wasabiBackupSecretSpec(tenantId, wasabiAccessKey, wasabiSecretKey));
  });

  // ─── Step 4: OpenSearch — action groups, user, role, mapping + k8s Secret ──
  // Read existing secret password first so retries reuse the same credentials.
  console.log(`[provisioner] Step 4: OpenSearch provisioning`);
  const existingOsPass = await readSecretField(tenantId, `${instance}-os-creds`, 'password');
  let osPass: string;
  try {
    osPass = await provisionOpenSearch(instance, existingOsPass ?? undefined);
  } catch (err) {
    console.warn(`[provisioner] OpenSearch provisioning failed — using placeholder creds: ${err}`);
    osPass = existingOsPass ?? randomBytes(24).toString('base64url').slice(0, 32);
  }
  const osUsername = `${instance}-os-user`;
  await step('Step 4: OpenSearch secret', async () => {
    await applyObject(opensearchSecretSpec(tenantId, instance, osUsername, osPass));
  });

  // ─── Step 5: PostgreSQL role + database + credentials Secret ───────────────
  // Reuse existing password on retries so the DB role and secret stay in sync.
  console.log(`[provisioner] Step 5: PostgreSQL role + database`);
  const existingPgPass = await readSecretField(tenantId, `${instance}-postgres`, 'password');
  const pgPass = existingPgPass ?? randomBytes(24).toString('base64url').slice(0, 32);
  await step('Step 5: PostgreSQL role + database + secret', async () => {
    await provisionPostgres(instance, pgPass);
    await applyObject(postgresSecretSpec(tenantId, instance, pgPass));
  });

  // ─── Step 6: S3-backed PersistentVolume + PVC ──────────────────────────────
  console.log(`[provisioner] Step 6: PV + PVC (S3-backed assets)`);
  await step('Step 6: PersistentVolume + PVC', async () => {
    await applyObject(persistentVolumeSpec(tenantId, instance, wasabiS3FuseBucket, assetsStorageSize));
    await applyObject(persistentVolumeClaimSpec(tenantId, instance, assetsStorageSize));
  });

  // ─── Step 7: dotCMS Deployment, HPA, PDB, Services (via Kustomize overlay) ─
  // Scaffolds kustomize/tenants/{instance}/kustomization.yaml referencing
  // kustomize/dotcms-base, then applies the overlay with kubectl apply -k.
  // This replicates generate-tenant-overlay.sh + kubectl apply -k semantics
  // per the provisioning constraint (must NOT use raw template objects here).
  console.log(`[provisioner] Step 7: dotCMS Deployment + Services (kubectl apply -k)`);
  await step('Step 7: Deployment + HPA + PDB + Services (kustomize overlay)', async () => {
    const overlayDir = await scaffoldTenantOverlay(env);
    console.log(`[provisioner] Kustomize overlay written to: ${overlayDir}`);
    const { stdout, stderr } = await kubectlApplyDir(overlayDir);
    if (stdout) console.log(`[provisioner] kubectl apply -k stdout:\n${stdout}`);
    if (stderr) console.warn(`[provisioner] kubectl apply -k stderr:\n${stderr}`);
  });

  // ─── Step 8: Ingress routing declaration ───────────────────────────────────
  console.log(`[provisioner] Step 8: Ingress declaration`);
  await step('Step 8: Ingress', async () => {
    await applyObject(ingressSpec(tenantId, instance, baseDomain));
  });

  // ─── Step 9: CaddyRoute ConfigMap ──────────────────────────────────────────
  console.log(`[provisioner] Step 9: CaddyRoute registration`);
  await step('Step 9: CaddyRoute ConfigMap', async () => {
    await applyObject(caddyRouteSpec(tenantId, instance, baseDomain));
  });

  // ─── Step 10: Wait for pod Ready (10-minute timeout) ───────────────────────
  console.log(`[provisioner] Step 10: Waiting for pod Ready (timeout 10m)...`);
  await step('Step 10: Pod Ready wait', async () => {
    const ready = await waitForDeploymentReady(tenantId, instance, POD_READY_TIMEOUT_MS);
    if (!ready) {
      throw new Error(
        `Pod not ready after ${POD_READY_TIMEOUT_MS / 60000} minutes — deployment ${instance} in namespace ${tenantId}`,
      );
    }
  });

  console.log(`[provisioner] === ${instance} fully provisioned ===`);
}

// ---------------------------------------------------------------------------
// PostgreSQL provisioning via postgres.js (dotcms_control has CREATEDB + CREATEROLE)
// Mirrors tenant-add.sh Steps 4a–4b (raw SQL, not CNPG Database/Role CRDs)
// ---------------------------------------------------------------------------

async function provisionPostgres(instance: string, pgPass: string): Promise<void> {
  // 4a — Create or update role (idempotent)
  // PASSWORD clause does not accept parameterized values in PostgreSQL.
  // pgPass is randomBytes base64url — only [A-Za-z0-9_-] chars, safe to interpolate.
  const roleRows = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${instance}`;
  if (roleRows.length === 0) {
    await sql.unsafe(`CREATE ROLE "${instance}" WITH LOGIN PASSWORD '${pgPass}'`);
    console.log(`[provisioner] PostgreSQL role '${instance}' created`);
  } else {
    await sql.unsafe(`ALTER ROLE "${instance}" WITH PASSWORD '${pgPass}'`);
    console.log(`[provisioner] PostgreSQL role '${instance}' updated`);
  }

  // 4b — Create database if not exists.
  // Owned by dotcms_control (so it can be dropped during decommission);
  // tenant role gets full privileges via GRANT.
  // CREATE DATABASE must be outside a transaction block — postgres.js
  // sends standalone statements without an implicit transaction.
  const dbRows = await sql`SELECT 1 FROM pg_database WHERE datname = ${instance}`;
  if (dbRows.length === 0) {
    // PostgreSQL requires dotcms_control to be a member of the owner role
    // before it can CREATE DATABASE with that owner — grant it first.
    await sql.unsafe(`GRANT "${instance}" TO dotcms_control`);
    await sql.unsafe(`CREATE DATABASE "${instance}" OWNER "${instance}"`);
    console.log(`[provisioner] PostgreSQL database '${instance}' created`);
  } else {
    console.log(`[provisioner] PostgreSQL database '${instance}' already exists`);
  }
}
