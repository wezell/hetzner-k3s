/**
 * Database helpers for the polling worker.
 *
 * Intentionally kept separate from the HTTP API layer so the worker can import
 * the DB client without pulling in Next.js server internals.
 */

import { sql } from '@/db';
import type { AppliedConfig, CustomerEnv, DeployStatus, LogAction, LogStatus } from '@/db/types';

// ---------------------------------------------------------------------------
// Poll: fetch all envs that need worker attention
// ---------------------------------------------------------------------------

/** Returns customer_env rows where deploy_status is one of the given statuses. */
export async function getPendingEnvs(statuses: DeployStatus[]): Promise<CustomerEnv[]> {
  return sql<CustomerEnv[]>`
    SELECT *
    FROM customer_env
    WHERE deploy_status = ANY(${sql.array(statuses)})
    ORDER BY mod_date ASC
  `;
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export async function setEnvStatus(
  orgKey: string,
  envKey: string,
  status: DeployStatus,
  extra?: { last_deploy_date?: boolean; stop_date?: boolean; dcomm_date?: boolean },
): Promise<void> {
  const now = new Date().toISOString();

  if (extra?.last_deploy_date) {
    await sql`
      UPDATE customer_env
      SET deploy_status = ${status}, last_deploy_date = ${now}
      WHERE org_key = ${orgKey} AND env_key = ${envKey}
    `;
  } else if (extra?.stop_date) {
    await sql`
      UPDATE customer_env
      SET deploy_status = ${status}, stop_date = ${now}
      WHERE org_key = ${orgKey} AND env_key = ${envKey}
    `;
  } else if (extra?.dcomm_date) {
    await sql`
      UPDATE customer_env
      SET deploy_status = ${status}, dcomm_date = ${now}
      WHERE org_key = ${orgKey} AND env_key = ${envKey}
    `;
  } else {
    await sql`
      UPDATE customer_env
      SET deploy_status = ${status}
      WHERE org_key = ${orgKey} AND env_key = ${envKey}
    `;
  }
}

// ---------------------------------------------------------------------------
// Deployment log
// ---------------------------------------------------------------------------

export async function writeLog(
  orgKey: string,
  envKey: string,
  action: LogAction,
  status: LogStatus,
  errorDetail?: string | null,
  retryCount?: number,
): Promise<void> {
  await sql`
    INSERT INTO deployment_log
      (log_org_key, log_env_key, action, status, error_detail, retry_count)
    VALUES
      (${orgKey}, ${envKey}, ${action}, ${status}, ${errorDetail ?? null}, ${retryCount ?? 0})
  `;
}

// ---------------------------------------------------------------------------
// Worker state watermark
// ---------------------------------------------------------------------------

export async function updateWorkerTimestamp(): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    UPDATE worker_state
    SET last_poll_timestamp = ${now}, updated_at = ${now}
    WHERE id = 1
  `;
}

export async function getWorkerTimestamp(): Promise<string | null> {
  const rows = await sql<{ last_poll_timestamp: string }[]>`
    SELECT last_poll_timestamp FROM worker_state WHERE id = 1
  `;
  return rows[0]?.last_poll_timestamp ?? null;
}

// ---------------------------------------------------------------------------
// Stop-date detection: enqueue deployed envs whose stop_date has elapsed
// ---------------------------------------------------------------------------

/**
 * Finds all customer_env rows in 'deployed' status where stop_date is set and
 * has elapsed (stop_date <= NOW()). Atomically transitions them to 'stopping'
 * so the poll loop can pick them up for scale-down processing.
 *
 * Returns the list of enqueued envs for logging.
 */
/**
 * For deployed environments whose stop_date has elapsed but replicas are still
 * > 0, set replicas = 0 so that detectAndEnqueueReconfigs picks up the drift
 * and patches the K8s deployment to scale-to-zero.
 *
 * This handles scheduled stops set via the settings form date picker.
 * Immediate stops (via the Stop button) already set replicas=0 in the API.
 */
export async function applyElapsedStops(): Promise<void> {
  const rows = await sql<{ org_key: string; env_key: string }[]>`
    UPDATE customer_env
    SET replicas = 0,
        mod_date = NOW()
    WHERE deploy_status = 'deployed'
      AND stop_date IS NOT NULL
      AND stop_date <= NOW()
      AND replicas > 0
    RETURNING org_key, env_key
  `;

  for (const row of rows) {
    console.log(`[worker] stop_date elapsed for ${row.org_key}-${row.env_key} — set replicas=0 for drift detection`);
  }
}

// ---------------------------------------------------------------------------
// Crash recovery: reset stuck 'provisioning' rows
// ---------------------------------------------------------------------------

/**
 * Finds customer_env rows that have been stuck in 'provisioning' status
 * longer than the pod-ready timeout (10 minutes). These are rows where the
 * worker process crashed mid-provision. Resets them to 'pending' so they
 * can be retried on the next poll cycle.
 *
 * Returns the number of rows recovered.
 */
export async function recoverStuckProvisioningRows(
  timeoutMs: number = 10 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();

  const recovered = await sql<{ org_key: string; env_key: string }[]>`
    UPDATE customer_env
    SET deploy_status = 'pending'
    WHERE deploy_status = 'provisioning'
      AND mod_date < ${cutoff}
    RETURNING org_key, env_key
  `;

  for (const row of recovered) {
    console.warn(
      `[worker] Recovered stuck provisioning row: ${row.org_key}-${row.env_key} (reset to pending)`,
    );
    // Write a log entry so operators can see the recovery event.
    await sql`
      INSERT INTO deployment_log
        (log_org_key, log_env_key, action, status, error_detail, retry_count)
      VALUES
        (${row.org_key}, ${row.env_key}, 'provision', 'retrying',
         'Worker crash recovery: reset from stuck provisioning to pending', 0)
    `;
  }

  return recovered.length;
}

// ---------------------------------------------------------------------------
// Config-change detection: enqueue deployed envs whose config has drifted
// ---------------------------------------------------------------------------

/**
 * Compares current customer_env config fields against the last_applied_config
 * snapshot for all 'deployed' environments.  Any row where the live values
 * differ from the stored snapshot is atomically transitioned to 'reconfiguring'
 * so the poll loop can pick it up for a kustomize reconciliation patch.
 *
 * Fields tracked for drift:
 *   image, replicas, memory_req, memory_limit, cpu_req, cpu_limit, env_vars
 *
 * Rows where last_applied_config IS NULL are skipped — they have never been
 * successfully provisioned and will be handled by the pending → provisioning
 * path instead.
 *
 * Returns the list of enqueued envs for logging.
 */
export async function detectAndEnqueueReconfigs(): Promise<
  { org_key: string; env_key: string }[]
> {
  const enqueued = await sql<{ org_key: string; env_key: string }[]>`
    UPDATE customer_env
    SET deploy_status = 'reconfiguring',
        mod_date      = NOW()
    WHERE deploy_status IN ('deployed', 'stopped')
      AND last_applied_config IS NOT NULL
      AND (last_applied_at IS NULL OR mod_date > last_applied_at)
      AND (
        image        != (last_applied_config->>'image')
        OR replicas  != (last_applied_config->>'replicas')::INTEGER
        OR memory_req   != (last_applied_config->>'memory_req')
        OR memory_limit != (last_applied_config->>'memory_limit')
        OR cpu_req   != (last_applied_config->>'cpu_req')
        OR cpu_limit != (last_applied_config->>'cpu_limit')
        OR env_vars  != (last_applied_config->'env_vars')
      )
    RETURNING org_key, env_key
  `;

  for (const row of enqueued) {
    const instance = `${row.org_key}-${row.env_key}`;
    console.log(`[worker] Config drift detected for ${instance} — enqueued for reconfiguration`);
    await sql`
      INSERT INTO deployment_log
        (log_org_key, log_env_key, action, status, error_detail, retry_count)
      VALUES
        (${row.org_key}, ${row.env_key}, 'patch', 'retrying',
         'Config drift detected — enqueued for kustomize reconciliation', 0)
    `;
  }

  return enqueued;
}

// ---------------------------------------------------------------------------
// Last-applied config snapshot: record state after successful provision/patch
// ---------------------------------------------------------------------------

/**
 * Saves a snapshot of the current config fields into last_applied_config.
 *
 * Called after every successful provision or patch so the next poll cycle can
 * compare the live customer_env values against this baseline to detect drift.
 */
export async function updateLastAppliedConfig(
  orgKey: string,
  envKey: string,
  config: AppliedConfig,
): Promise<void> {
  await sql`
    UPDATE customer_env
    SET last_applied_config = ${sql.json(config as never)},
        last_applied_at     = NOW()
    WHERE org_key = ${orgKey} AND env_key = ${envKey}
  `;
}

// ---------------------------------------------------------------------------
// Crash recovery: reset stuck 'reconfiguring' rows
// ---------------------------------------------------------------------------

/**
 * Finds customer_env rows stuck in 'reconfiguring' longer than the given
 * timeout. Resets them back to 'deployed' so the next poll cycle re-detects
 * the config drift and re-enqueues them for a fresh patch attempt.
 *
 * Returns the number of rows recovered.
 */
export async function recoverStuckReconfiguringRows(
  timeoutMs: number = 10 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();

  const recovered = await sql<{ org_key: string; env_key: string }[]>`
    UPDATE customer_env
    SET deploy_status = 'deployed'
    WHERE deploy_status = 'reconfiguring'
      AND mod_date < ${cutoff}
    RETURNING org_key, env_key
  `;

  for (const row of recovered) {
    console.warn(
      `[worker] Recovered stuck reconfiguring row: ${row.org_key}-${row.env_key} (reset to deployed for re-detection)`,
    );
    await sql`
      INSERT INTO deployment_log
        (log_org_key, log_env_key, action, status, error_detail, retry_count)
      VALUES
        (${row.org_key}, ${row.env_key}, 'patch', 'retrying',
         'Worker crash recovery: reset from stuck reconfiguring to deployed', 0)
    `;
  }

  return recovered.length;
}

// ---------------------------------------------------------------------------
// Retry-count persistence: read prior attempt count from deployment_log
// ---------------------------------------------------------------------------

/**
 * Returns the number of retry attempts already recorded in deployment_log for
 * a given (org_key, env_key, action) tuple SINCE the last successful operation.
 *
 * Used by runWithRetry in poll.ts to resume from the correct attempt index
 * after a worker crash + recovery, preventing the retry cap from resetting.
 *
 * Algorithm:
 *   MAX(retry_count) from 'retrying' entries that have no 'success' entry
 *   written after them.  This correctly handles:
 *     - First attempt ever → 0 (no entries)
 *     - After 2 retries and a crash → 2 (resumes from attempt 2, 1 try left)
 *     - After a previous success and a new failure → 0 (success resets window)
 *     - After all retries exhausted (env='failed') → caller skips re-attempting
 *
 * @returns prior retry count (0 = no previous retries since last success)
 */
export async function getRetryCount(
  orgKey: string,
  envKey: string,
  action: LogAction,
): Promise<number> {
  const result = await sql<{ prior_retries: string }[]>`
    SELECT COALESCE(MAX(dl.retry_count), 0) AS prior_retries
    FROM deployment_log dl
    WHERE dl.log_org_key = ${orgKey}
      AND dl.log_env_key = ${envKey}
      AND dl.action      = ${action}
      AND dl.status      = 'retrying'
      AND NOT EXISTS (
        SELECT 1
        FROM deployment_log dl2
        WHERE dl2.log_org_key = ${orgKey}
          AND dl2.log_env_key = ${envKey}
          AND dl2.action      = ${action}
          AND dl2.status      = 'success'
          AND dl2.created_date > dl.created_date
      )
  `;
  return parseInt(result[0]?.prior_retries ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Namespace lifecycle: count remaining active envs for an org
// ---------------------------------------------------------------------------

/**
 * Returns the count of customer_env rows for the given org that are NOT in
 * 'decommissioned' status, excluding the environment currently being
 * decommissioned (which hasn't been marked decommissioned in the DB yet).
 *
 * Used by the decommission orchestrator to decide whether to delete the
 * Kubernetes namespace: if count == 0, this is the last active environment
 * for the org and the shared namespace should be cleaned up.
 */
export async function getActiveEnvCountForOrg(
  orgKey: string,
  excludeEnvKey: string,
): Promise<number> {
  const result = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count
    FROM customer_env
    WHERE org_key   = ${orgKey}
      AND env_key  != ${excludeEnvKey}
      AND deploy_status != 'decommissioned'
  `;
  return parseInt(result[0]?.count ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Hard-delete an env row (and its deployment logs) from the database.
// Only call this after all Kubernetes/Postgres/OpenSearch resources have been
// cleaned up by the decommissioner — i.e. after deploy_status = 'decommissioned'.
// ---------------------------------------------------------------------------

export async function hardDeleteEnv(orgKey: string, envKey: string): Promise<void> {
  await sql.begin(async (tx) => {
    // Logs first (FK to customer_env)
    await tx`
      DELETE FROM deployment_log
      WHERE log_org_key = ${orgKey}
        AND log_env_key = ${envKey}
    `;
    await tx`
      DELETE FROM customer_env
      WHERE org_key = ${orgKey}
        AND env_key = ${envKey}
    `;
  });
}
