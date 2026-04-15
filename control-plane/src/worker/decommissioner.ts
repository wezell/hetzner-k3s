/**
 * Decommissioner — replicates tenant-remove.sh --env-only behaviour.
 *
 * Removes all Kubernetes resources for a single tenant environment without
 * touching other environments in the same namespace. Mirrors the
 * deprovision_instance() function and env-only cleanup in tenant-remove.sh.
 *
 * Deletion order:
 *   1. Scale Deployment to 0 (graceful drain)
 *   2. Delete Deployment + HPA + PDB
 *   3. Delete Services (ClusterIP + Headless)
 *   4. Delete Secrets
 *   5. Delete PVC (namespace-scoped)
 *   6. Delete PV (cluster-scoped)
 *   7. Delete Ingress
 *   8. Delete CaddyRoute ConfigMap
 *   9. Drop Postgres DB + role (via exec into shared CNPG pod)
 *  10. Remove OpenSearch user/role/mapping (via in-cluster REST API)
 *  11. Delete tenant Kubernetes namespace if this is the last env for the org
 *      (cascades to remove ResourceQuota, LimitRange, Valkey Service, etc.)
 */

import type { CustomerEnv } from '@/db/types';
import { deleteObject, patchDeploymentReplicas, forceDeleteNamespace } from './k8s';
import { deprovisionOpenSearch } from './opensearch';
import { getActiveEnvCountForOrg } from './db-worker';
import { runStep } from './logger';
import { sql } from '@/db';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nsObj(
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string,
): Record<string, unknown> {
  return { apiVersion, kind, metadata: { name, namespace } };
}

function clusterObj(
  apiVersion: string,
  kind: string,
  name: string,
): Record<string, unknown> {
  return { apiVersion, kind, metadata: { name } };
}

// ---------------------------------------------------------------------------
// Scale-to-zero — soft stop that preserves all tenant data.
//
// Called by the polling worker when stop_date elapses. Unlike decommissionEnv(),
// this function ONLY scales the Deployment to 0 replicas and does NOT touch
// PVCs, Secrets, Services, Ingress, Postgres, or OpenSearch resources.
// All stateful data is intentionally left intact so the environment can be
// restarted later (e.g. by scaling replicas back up).
// ---------------------------------------------------------------------------

export async function scaleDownEnv(env: CustomerEnv): Promise<void> {
  const tenantId = env.org_key;
  const instance = `${tenantId}-${env.env_key}`;
  console.log(`[decommissioner] Scale-to-zero ${instance} (preserving all stateful resources)`);
  await runStep(env.org_key, env.env_key, 'stop', 'Step 1: Scale Deployment to 0', async () => {
    await patchDeploymentReplicas(tenantId, instance, 0);
  });
  console.log(`[decommissioner] ${instance} scaled to 0 — all PVCs, Secrets, and data preserved`);
}

// ---------------------------------------------------------------------------
// Main decommission entry point
// ---------------------------------------------------------------------------

export async function decommissionEnv(env: CustomerEnv): Promise<void> {
  const tenantId = env.org_key;
  const envId = env.env_key;
  const instance = `${tenantId}-${envId}`;

  console.log(`[decommissioner] === Decommissioning ${instance} ===`);

  // Convenience shorthand — step errors are logged then re-thrown so
  // the outer runWithRetry in poll.ts handles retry / status transitions.
  const step = (name: string, fn: () => Promise<void>) =>
    runStep(env.org_key, env.env_key, 'decommission', name, fn);

  // 1 — Scale Deployment to 0 before deletion (graceful drain)
  console.log(`[decommissioner] Scaling deployment to 0`);
  try {
    await step('Step 1: Scale Deployment to 0', async () => {
      await patchDeploymentReplicas(tenantId, instance, 0);
    });
  } catch {
    // Non-fatal — the deployment may already be absent on a re-run.
    console.warn(`[decommissioner] Scale-to-0 failed (deployment may not exist) — continuing`);
  }

  // 2 — Delete Deployment, HPA, PDB
  console.log(`[decommissioner] Deleting Deployment + HPA + PDB`);
  await step('Step 2: Delete Deployment + HPA + PDB', async () => {
    await deleteObject(nsObj('apps/v1', 'Deployment', instance, tenantId));
    await deleteObject(nsObj('autoscaling/v2', 'HorizontalPodAutoscaler', instance, tenantId));
    await deleteObject(nsObj('policy/v1', 'PodDisruptionBudget', instance, tenantId));
  });

  // 3 — Delete Services
  console.log(`[decommissioner] Deleting Services`);
  await step('Step 3: Delete Services', async () => {
    await deleteObject(nsObj('v1', 'Service', instance, tenantId));
    await deleteObject(nsObj('v1', 'Service', `${instance}-hl`, tenantId));
  });

  // 4 — Delete Secrets
  console.log(`[decommissioner] Deleting Secrets`);
  await step('Step 4: Delete Secrets', async () => {
    await deleteObject(nsObj('v1', 'Secret', `${instance}-valkey`, tenantId));
    await deleteObject(nsObj('v1', 'Secret', `${instance}-postgres`, tenantId));
    await deleteObject(nsObj('v1', 'Secret', `${instance}-os-creds`, tenantId));
  });

  // 5 — Delete PVC (namespace-scoped)
  console.log(`[decommissioner] Deleting PVC`);
  await step('Step 5: Delete PVC', async () => {
    await deleteObject(nsObj('v1', 'PersistentVolumeClaim', `${instance}-assets`, tenantId));
  });

  // 6 — Delete PV (cluster-scoped — not removed by namespace deletion)
  console.log(`[decommissioner] Deleting PV`);
  await step('Step 6: Delete PV', async () => {
    await deleteObject(clusterObj('v1', 'PersistentVolume', `${instance}-assets`));
  });

  // 7 — Delete Ingress
  console.log(`[decommissioner] Deleting Ingress`);
  await step('Step 7: Delete Ingress', async () => {
    await deleteObject(nsObj('networking.k8s.io/v1', 'Ingress', instance, tenantId));
  });

  // 8 — Delete CaddyRoute ConfigMap (caddy-ingress namespace — cluster-scoped effect)
  console.log(`[decommissioner] Deleting CaddyRoute ConfigMap`);
  await step('Step 8: Delete CaddyRoute ConfigMap', async () => {
    await deleteObject(nsObj('v1', 'ConfigMap', `route-${instance}`, 'caddy-ingress'));
  });

  // 9 — Drop Postgres DB + role via exec into shared CNPG pod
  console.log(`[decommissioner] Dropping Postgres database + role`);
  await step('Step 9: Drop Postgres database + role', async () => {
    await deprovisionPostgres(instance);
  });

  // 10 — Remove OpenSearch user/role/mapping
  console.log(`[decommissioner] Removing OpenSearch resources`);
  try {
    await step('Step 10: Remove OpenSearch user/role/mapping', async () => {
      await deprovisionOpenSearch(instance);
    });
  } catch (err) {
    // Non-fatal — OpenSearch may be absent in dev/test environments.
    console.warn(`[decommissioner] OpenSearch cleanup failed (non-fatal): ${err}`);
  }

  // 11 — Delete tenant namespace if this is the last active env for the org.
  //
  // The namespace (= tenantId = org_key) is shared across all environments
  // belonging to the same org. Deleting it cascades to remove all remaining
  // namespace-scoped resources (ResourceQuota, LimitRange, Valkey ExternalName
  // Service, wasabi-backup-creds Secret, etc.) that are per-tenant rather than
  // per-env and therefore not removed by steps 2–8 above.
  //
  // We skip deletion if other non-decommissioned envs still exist so those
  // envs' resources are not inadvertently destroyed.
  console.log(`[decommissioner] Checking whether to delete namespace ${tenantId}`);
  const remainingActiveEnvs = await getActiveEnvCountForOrg(tenantId, envId);
  if (remainingActiveEnvs === 0) {
    console.log(
      `[decommissioner] No other active envs for org ${tenantId} — deleting namespace`,
    );
    await step('Step 11: Delete tenant namespace', async () => {
      await forceDeleteNamespace(tenantId);
    });
    console.log(`[decommissioner] Namespace ${tenantId} deleted (cascade removes all remaining resources)`);
  } else {
    console.log(
      `[decommissioner] ${remainingActiveEnvs} active env(s) remain for org ${tenantId} — preserving namespace`,
    );
  }

  console.log(`[decommissioner] === ${instance} decommissioned ===`);
}

// ---------------------------------------------------------------------------
// Postgres teardown (mirrors deprovision_instance() in tenant-remove.sh)
// Uses raw SQL via kubectl exec — NOT CNPG Database/Role CRDs (per constraint).
// ---------------------------------------------------------------------------

async function deprovisionPostgres(instance: string): Promise<void> {
  try {
    // Terminate active connections as dotcms_control (it can terminate connections
    // from the instance role since GRANT "instance" TO dotcms_control was run).
    await sql`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${instance} AND pid <> pg_backend_pid()
    `;

    // DROP DATABASE requires acting as the database owner ("instance").
    // Open a single dedicated connection, SET ROLE to the owner, then DROP.
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const single = postgres(dbUrl, { max: 1, idle_timeout: 10 });
      try {
        // Ensure dotcms_control has the role (idempotent)
        await single.unsafe(`GRANT "${instance}" TO dotcms_control`);
        // Act as the owner so DROP DATABASE is permitted
        await single.unsafe(`SET ROLE "${instance}"`);
        await single.unsafe(`DROP DATABASE IF EXISTS "${instance}"`);
        console.log(`[decommissioner] Postgres database '${instance}' dropped`);
      } finally {
        await single.end();
      }
    }

    // DROP ROLE — dotcms_control has CREATEROLE so can drop non-superuser roles
    await sql.unsafe(`DROP ROLE IF EXISTS "${instance}"`);
    console.log(`[decommissioner] Postgres role '${instance}' dropped`);
  } catch (err) {
    console.warn(`[decommissioner] Postgres teardown partial failure (non-fatal):`, err);
  }
}
