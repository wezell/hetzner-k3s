/**
 * Polling worker — detects pending/decommission customer_env records and
 * executes the appropriate provisioning or teardown workflow.
 *
 * Design:
 *   • Sequential processing — one env at a time (MVP scale < 20 envs).
 *   • 30-second poll interval (configurable via WORKER_POLL_INTERVAL_MS).
 *   • Exponential backoff retry: up to 3 attempts (delays: 5s, 15s, 45s).
 *   • Pod Ready timeout: 10 minutes before marking failed.
 *   • All state persisted to PostgreSQL — worker restarts safely.
 *
 * Status state machine:
 *   pending       → provisioning → deployed       (provision success)
 *   pending       → provisioning → failed         (3 retries exhausted)
 *   deployed      → reconfiguring                 (config drift detected vs last_applied_config)
 *   reconfiguring → deployed                      (kustomize patch applied, Sub-AC 3b)
 *   reconfiguring → failed                        (3 retries exhausted)
 *   deployed      → stopping                      (stop_date elapsed, detected by worker)
 *   stopping      → stopped                       (scale-to-zero complete)
 *   stopping      → failed                        (3 retries exhausted)
 *   *             → decommissioning               (dcomm_date elapsed, any non-decommissioned state)
 *   decommissioning → decommissioned             (all resources removed)
 *   decommissioning → failed                     (3 retries exhausted)
 */

import type { CustomerEnv } from '@/db/types';
import {
  getPendingEnvs,
  setEnvStatus,
  writeLog,
  updateWorkerTimestamp,
  recoverStuckProvisioningRows,
  recoverStuckReconfiguringRows,
  detectAndEnqueueReconfigs,
  applyElapsedStops,
  updateLastAppliedConfig,
  getRetryCount,
  hardDeleteEnv,
} from './db-worker';
import { provisionEnv } from './provisioner';
import { errToString } from './logger';
import { decommissionEnv } from './decommissioner';
import { sleep, kubectlApplyDir } from './k8s';
import { scaffoldTenantOverlay } from './kustomize';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? '30000', 10);
const MAX_RETRIES = 3;
// Pod Ready timeout before marking provisioning as failed (10 minutes per constraint)
const POD_READY_TIMEOUT_MS = 10 * 60 * 1_000;

// Exponential backoff delays between retry attempts (ms)
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------
let _workerRunning = false;
let _stopRequested = false;

/** Start the polling loop in the background. Idempotent — safe to call multiple times. */
export function startWorker(): void {
  if (_workerRunning) {
    console.log('[worker] Already running — ignoring duplicate startWorker() call');
    return;
  }
  _workerRunning = true;
  _stopRequested = false;
  console.log(`[worker] Starting — poll interval ${POLL_INTERVAL_MS / 1000}s`);
  // Fire-and-forget: runs until stopWorker() is called or process exits.
  runLoop().catch((err) => {
    console.error('[worker] Fatal error in poll loop:', err);
    _workerRunning = false;
  });
}

/** Gracefully stop the polling loop after the current cycle completes. */
export function stopWorker(): void {
  console.log('[worker] Stop requested');
  _stopRequested = true;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runLoop(): Promise<void> {
  while (!_stopRequested) {
    try {
      await pollOnce();
      await updateWorkerTimestamp();
    } catch (err) {
      // Log but don't crash — the loop recovers on the next cycle.
      console.error('[worker] Poll cycle error:', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  _workerRunning = false;
  console.log('[worker] Stopped');
}

// ---------------------------------------------------------------------------
// Single poll cycle
// ---------------------------------------------------------------------------

/** Exported for integration testing — runs one full poll cycle. */
export async function pollOnce(): Promise<void> {
  // Recover any rows stuck in 'provisioning' due to a previous worker crash.
  // Uses mod_date as the watermark: rows older than the 10-min pod-ready
  // timeout are assumed orphaned and reset to 'pending' for retry.
  await recoverStuckProvisioningRows(POD_READY_TIMEOUT_MS);

  // Recover any rows stuck in 'reconfiguring' due to a previous worker crash.
  // Resets them to 'deployed' so the drift-detection query below re-detects
  // the config change and re-enqueues them for patching.
  await recoverStuckReconfiguringRows(POD_READY_TIMEOUT_MS);

  // For scheduled stops: if stop_date has elapsed but replicas > 0, set replicas=0
  // so the drift detection below picks it up and patches the K8s deployment.
  await applyElapsedStops();

  // Detect environments (deployed or stopped) whose config fields differ from
  // last_applied_config and atomically transition them to 'reconfiguring'.
  // Sub-AC 3b will apply the kustomize reconciliation patch for these rows.
  await detectAndEnqueueReconfigs();

  // Fetch envs needing attention:
  //   'pending'       → run provision workflow
  //   'reconfiguring' → config drift detected, reconciliation patch pending (Sub-AC 3b)
  //   'stopping'      → stop_date elapsed, scale to 0 replicas
  //   'deployed'      → check for elapsed dcomm_date
  //   'stopped'       → check for elapsed dcomm_date
  //   'failed'        → check for elapsed dcomm_date (operator teardown of failed env)
  const envs = await getPendingEnvs(['pending', 'reconfiguring', 'decommissioning', 'deployed', 'stopped', 'failed']);

  // Snapshot current time once per cycle for consistent temporal comparisons.
  const now = new Date();

  for (const env of envs) {
    if (_stopRequested) break;

    // Temporal check: dcomm_date must be set AND have elapsed before triggering.
    // Supports both immediate decommissions (dcomm_date = NOW) and scheduled
    // future decommissions (dcomm_date = some future timestamp set by the UI).
    const needsDecommission =
      env.dcomm_date !== null && new Date(env.dcomm_date) <= now;

    if (needsDecommission || env.deploy_status === 'decommissioning') {
      await runWithRetry(env, 'decommission', () => decommissionEnv(env));
    } else if (env.deploy_status === 'reconfiguring') {
      // Config drift detected — re-render the full kustomize overlay so
      // the Deployment spec (including selector, labels, etc.) is always
      // complete. Using the partial kubectlApplyKustomize approach caused
      // null-selector errors because it applied a resource without a selector.
      await runWithRetry(env, 'patch', async () => {
        const overlayDir = await scaffoldTenantOverlay(env);
        const { stdout, stderr } = await kubectlApplyDir(overlayDir);
        if (stdout) console.log(`[worker] ${env.org_key}-${env.env_key} kubectl apply stdout: ${stdout.trim()}`);
        if (stderr) console.warn(`[worker] ${env.org_key}-${env.env_key} kubectl apply stderr: ${stderr.trim()}`);
      });
    } else if (env.deploy_status === 'pending') {
      await runWithRetry(env, 'provision', () => provisionEnv(env));
    }
    // 'deployed' / 'stopped' / 'failed' with no elapsed dcomm_date — nothing to do.
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper with exponential backoff
// ---------------------------------------------------------------------------

async function runWithRetry(
  env: CustomerEnv,
  action: 'provision' | 'patch' | 'stop' | 'decommission',
  fn: () => Promise<void>,
): Promise<void> {
  const { org_key, env_key } = env;
  const instance = `${org_key}-${env_key}`;

  // Read prior attempt count from deployment_log so that retry caps survive
  // worker crashes.  If the worker crashed after recording 2 'retrying' entries,
  // on restart we resume from attempt 2 (1 try remaining) rather than resetting
  // the counter to 0 and inadvertently granting 3 additional attempts.
  const priorRetries = await getRetryCount(org_key, env_key, action);

  if (priorRetries >= MAX_RETRIES) {
    // All retries already exhausted in a previous worker run — mark failed
    // and surface for manual intervention without running fn() again.
    console.error(
      `[worker] ${action} ${instance} already exhausted ${MAX_RETRIES} retries (from deployment_log) — marking failed`,
    );
    await setEnvStatus(org_key, env_key, 'failed');
    await writeLog(
      org_key,
      env_key,
      action,
      'failed',
      `Retry cap (${MAX_RETRIES}) reached across worker restarts — manual intervention required`,
      priorRetries,
    );
    return;
  }

  // Transition to the in-progress status before the first attempt.
  if (action === 'provision') {
    await setEnvStatus(org_key, env_key, 'provisioning');
  } else if (action === 'decommission') {
    await setEnvStatus(org_key, env_key, 'decommissioning');
  }
  // 'patch' keeps the 'reconfiguring' status set by detectAndEnqueueReconfigs —
  // 'stop' keeps the 'stopping' status set by detectAndEnqueueStops —
  // no additional status transition needed before the first attempt.

  // Start the loop from priorRetries so cross-restart attempts are counted
  // against the same MAX_RETRIES cap.
  for (let attempt = priorRetries; attempt < MAX_RETRIES; attempt++) {
    try {
      await fn();

      // Success — set final status and write success log.
      if (action === 'provision' || action === 'patch') {
        // After a patch, replicas=0 means the env was stopped via the stop API.
        const finalStatus = (action === 'patch' && env.replicas === 0) ? 'stopped' : 'deployed';
        await setEnvStatus(org_key, env_key, finalStatus, { last_deploy_date: action === 'provision' });
        // Snapshot the applied config so future poll cycles can detect drift.
        await updateLastAppliedConfig(org_key, env_key, {
          image: env.image,
          replicas: env.replicas,
          memory_req: env.memory_req,
          memory_limit: env.memory_limit,
          cpu_req: env.cpu_req,
          cpu_limit: env.cpu_limit,
          env_vars: env.env_vars ?? {},
        });
      } else if (action === 'stop') {
        // Legacy path — kept for any in-flight 'stopping' rows during deploy.
        await setEnvStatus(org_key, env_key, 'stopped', { stop_date: true });
      } else {
        // Decommission: preserve the original dcomm_date set by the operator;
        // only transition the deploy_status to 'decommissioned'.
        await setEnvStatus(org_key, env_key, 'decommissioned');

        // If the operator used "Delete" (pending_delete flag), purge the row
        // now that all K8s/Postgres/OpenSearch resources have been cleaned up.
        if (env.pending_delete) {
          console.log(`[worker] pending_delete=true — hard-deleting ${instance} from DB`);
          await hardDeleteEnv(org_key, env_key);
        }
      }

      await writeLog(org_key, env_key, action, 'success', null, attempt + 1);
      console.log(`[worker] ${action} ${instance} succeeded (attempt ${attempt + 1})`);
      return;
    } catch (err: unknown) {
      const errMsg = errToString(err);
      console.error(
        `[worker] ${action} ${instance} failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${errMsg}`,
      );

      const isLastAttempt = attempt === MAX_RETRIES - 1;

      if (isLastAttempt) {
        // All retries exhausted — mark for manual intervention.
        await setEnvStatus(org_key, env_key, 'failed');
        await writeLog(org_key, env_key, action, 'failed', errMsg, attempt + 1);
        console.error(
          `[worker] ${instance} marked FAILED after ${MAX_RETRIES} attempts — manual intervention required`,
        );
      } else {
        // Log retry and wait with exponential backoff before next attempt.
        // Use the absolute attempt index (not relative) so the delay is correct
        // when resuming mid-sequence after a worker restart.
        await writeLog(org_key, env_key, action, 'retrying', errMsg, attempt + 1);
        const delay = RETRY_DELAYS_MS[attempt] ?? 45_000;
        console.log(`[worker] Retrying ${instance} in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }
}
