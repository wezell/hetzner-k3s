import { sql } from '@/db';
import type { CustomerEnv, DeployStatus, LogAction } from '@/db/types';

// ---------------------------------------------------------------------------
// POST /api/envs/[id]/retrigger
//
// Resets a failed (or otherwise stuck) environment back into the appropriate
// pending/queued state so the polling worker picks it up on the next cycle.
//
// This is the "manual intervention" escape hatch: when the worker marks an
// environment 'failed' after exhausting retries, an operator can trigger a
// fresh attempt via this endpoint.
//
// Route params:
//   id  — the org_key for the environment's parent organization
//
// Query params:
//   env_key  (required) — the environment key within the organization
//
// Request body (JSON):
//   action  (required) — one of: provision | patch | stop | decommission
//
// Action → queued status mapping:
//   provision    → 'pending'         (worker runs provisionEnv)
//   patch        → 'reconfiguring'   (worker runs kustomize patch)
//   stop         → 'stopping'        (worker runs scaleDownEnv)
//   decommission → 'decommissioning' (worker runs decommissionEnv)
//
// Retry reset:
//   Inserts a synthetic 'success' log entry so getRetryCount() returns 0,
//   allowing the worker 3 fresh retry attempts on the retriggered action.
//
// Guards:
//   • 400 — missing env_key or invalid/missing action
//   • 404 — environment not found
//   • 409 — environment is decommissioned (terminal, cannot retrigger)
//   • 500 — unexpected database error
//
// Example:
//   POST /api/envs/acme/retrigger?env_key=prod
//   Body: { "action": "provision" }
// ---------------------------------------------------------------------------

const VALID_ACTIONS = ['provision', 'patch', 'stop', 'decommission'] as const;

/** Map from LogAction to the deploy_status the worker picks up. */
const ACTION_TO_QUEUED_STATUS: Record<LogAction, DeployStatus> = {
  provision: 'pending',
  patch: 'reconfiguring',
  stop: 'stopping',
  decommission: 'decommissioning',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: org_key } = await params;
  const { searchParams } = new URL(request.url);
  const env_key = searchParams.get('env_key');

  if (!env_key) {
    return Response.json({ error: 'env_key query parameter is required' }, { status: 400 });
  }

  // Parse and validate the request body.
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const { action } = body ?? {};

  if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    return Response.json(
      { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  const typedAction = action as LogAction;
  const queuedStatus = ACTION_TO_QUEUED_STATUS[typedAction];

  try {
    // Fetch the environment to validate existence and guard against terminal state.
    const [env] = await sql<Pick<CustomerEnv, 'org_key' | 'env_key' | 'deploy_status'>[]>`
      SELECT org_key, env_key, deploy_status
      FROM customer_env
      WHERE org_key = ${org_key}
        AND env_key = ${env_key}
    `;

    if (!env) {
      return Response.json(
        { error: `Environment '${org_key}/${env_key}' not found` },
        { status: 404 },
      );
    }

    if (env.deploy_status === 'decommissioned') {
      return Response.json(
        {
          error: `Environment '${org_key}/${env_key}' is decommissioned and cannot be retriggered`,
          detail: `deploy_status is 'decommissioned' — create a new environment instead`,
        },
        { status: 409 },
      );
    }

    // Write a synthetic 'success' log entry to reset the retry window.
    //
    // getRetryCount() in poll.ts counts MAX(retry_count) from 'retrying' entries
    // that have NO 'success' entry written after them.  By inserting a 'success'
    // now, all prior 'retrying' entries will be shadowed by this newer success,
    // so getRetryCount() returns 0 — giving the worker 3 fresh attempts.
    await sql`
      INSERT INTO deployment_log
        (log_org_key, log_env_key, action, status, error_detail, retry_count)
      VALUES
        (${org_key}, ${env_key}, ${typedAction}, 'success',
         'Operator-initiated retrigger — retry window reset', 0)
    `;

    // Update deploy_status to the queued state and set date fields as needed.
    if (typedAction === 'provision') {
      // Clear stop_date and dcomm_date so the worker does not immediately
      // enqueue this newly-retriggered env for stop or decommission.
      await sql`
        UPDATE customer_env
        SET deploy_status = 'pending',
            stop_date     = NULL,
            dcomm_date    = NULL,
            mod_date      = NOW()
        WHERE org_key = ${org_key}
          AND env_key = ${env_key}
      `;
    } else if (typedAction === 'patch') {
      await sql`
        UPDATE customer_env
        SET deploy_status = 'reconfiguring',
            mod_date      = NOW()
        WHERE org_key = ${org_key}
          AND env_key = ${env_key}
      `;
    } else if (typedAction === 'stop') {
      // Preserve an existing stop_date (operator-set target time); if none,
      // set to NOW() so the temporal check in detectAndEnqueueStops passes.
      await sql`
        UPDATE customer_env
        SET deploy_status = 'stopping',
            stop_date     = COALESCE(stop_date, NOW()),
            mod_date      = NOW()
        WHERE org_key = ${org_key}
          AND env_key = ${env_key}
      `;
    } else {
      // decommission
      // Preserve an existing dcomm_date; if none, set to NOW() so the
      // temporal check in pollOnce passes (dcomm_date <= NOW()).
      await sql`
        UPDATE customer_env
        SET deploy_status = 'decommissioning',
            dcomm_date    = COALESCE(dcomm_date, NOW()),
            mod_date      = NOW()
        WHERE org_key = ${org_key}
          AND env_key = ${env_key}
      `;
    }

    return Response.json({
      org_key,
      env_key,
      action: typedAction,
      queued_status: queuedStatus,
      message: `Environment '${org_key}/${env_key}' queued for ${typedAction} (status → '${queuedStatus}')`,
    });
  } catch (err) {
    console.error(
      `[POST /api/envs/${org_key}/retrigger?env_key=${env_key}] Database error:`,
      err,
    );
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
