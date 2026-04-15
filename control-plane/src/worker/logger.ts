/**
 * Step-level logging middleware for the worker.
 *
 * `runStep` wraps an individual provisioning/decommission step in a try-catch
 * that writes a 'failed' deployment_log record (with step name embedded in
 * error_detail) whenever a step throws.  The original error is then re-thrown
 * so the outer runWithRetry handler in poll.ts continues to manage retry
 * logic, exponential backoff, and top-level status transitions.
 *
 * This gives operators per-step granularity in the deployment_log:
 *   {action: 'provision', status: 'failed',
 *    error_detail: '[Step 5: PostgreSQL role + database] FATAL: role "..." already exists'}
 *
 * rather than only the coarse-grained operation-level entry that runWithRetry
 * writes after exhausting all retries.
 */

import { writeLog } from './db-worker';
import type { LogAction } from '@/db/types';

/**
 * Executes a single provisioning/decommission step and records a failure log
 * entry if the step throws.
 *
 * @param orgKey   - customer_env.org_key (used as log_org_key)
 * @param envKey   - customer_env.env_key (used as log_env_key)
 * @param action   - top-level action ('provision' | 'patch' | 'stop' | 'decommission')
 * @param stepName - human-readable step label, e.g. "Step 5: PostgreSQL role + database"
 * @param fn       - async step implementation; must throw on failure
 */
/** Serialize any thrown value to a human-readable string.
 * Handles plain Error, k8s HttpError (has .body), and arbitrary objects. */
export function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // k8s-client HttpError: { statusCode, body: { message, ... } }
    if (e.body && typeof e.body === 'object') {
      const body = e.body as Record<string, unknown>;
      if (typeof body.message === 'string') return `HTTP ${e.statusCode ?? ''}: ${body.message}`;
      return `HTTP ${e.statusCode ?? ''}: ${JSON.stringify(body)}`;
    }
    if (typeof e.message === 'string') return e.message;
    return JSON.stringify(err);
  }
  return String(err);
}

export async function runStep(
  orgKey: string,
  envKey: string,
  action: LogAction,
  stepName: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const errMsg = errToString(err);
    const detail = `[${stepName}] ${errMsg}`;

    // Write step-level failure record before re-throwing.
    // Use retry_count=0 to distinguish step logs from the operation-level
    // retry entries written by runWithRetry in poll.ts.
    try {
      await writeLog(orgKey, envKey, action, 'failed', detail, 0);
    } catch (logErr) {
      // Never let logging failure mask the original step error.
      console.error(`[logger] Failed to write step log for ${orgKey}-${envKey}:`, logErr);
    }

    throw err; // preserve original error type and stack for runWithRetry
  }
}
