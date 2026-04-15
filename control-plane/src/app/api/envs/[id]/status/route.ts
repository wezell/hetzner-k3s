import { sql } from '@/db';
import type { CustomerEnv, DeploymentLog } from '@/db/types';

// ---------------------------------------------------------------------------
// GET /api/envs/[id]/status
//
// Returns the current deploy_status and recent deployment_log entries for a
// given environment.
//
// Route params:
//   id  — the org_key for the environment's parent organization
//
// Query params:
//   env_key  (required) — the environment key within the organization
//   limit    (optional) — max deployment_log entries to return (default 50)
//
// Example:
//   GET /api/envs/acme/status?env_key=prod
// ---------------------------------------------------------------------------

interface StatusResponse {
  org_key: string;
  env_key: string;
  deploy_status: CustomerEnv['deploy_status'];
  last_deploy_date: string | null;
  stop_date: string | null;
  dcomm_date: string | null;
  mod_date: string;
  /**
   * Number of retry attempts for the current (or most-recent) operation since
   * the last successful deployment_log entry.  0 = no retries outstanding.
   * Surfaces the same value that poll.ts's runWithRetry tracks so operators
   * can see when an env is approaching the 3-attempt cap.
   */
  current_retry_count: number;
  logs: DeploymentLog[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: org_key } = await params;
  const { searchParams } = new URL(request.url);
  const env_key = searchParams.get('env_key');
  const limitParam = searchParams.get('limit');

  // --- Validate path param ---
  if (!org_key || typeof org_key !== 'string') {
    return Response.json({ error: 'org_key path parameter is required' }, { status: 400 });
  }

  // --- Validate query params ---
  if (!env_key) {
    return Response.json(
      { error: 'env_key query parameter is required' },
      { status: 400 }
    );
  }

  let logLimit = 50;
  if (limitParam !== null) {
    const parsed = parseInt(limitParam, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 500) {
      return Response.json(
        { error: 'limit must be an integer between 1 and 500' },
        { status: 400 }
      );
    }
    logLimit = parsed;
  }

  try {
    // Fetch the environment row
    const [env] = await sql<CustomerEnv[]>`
      SELECT
        org_key,
        env_key,
        deploy_status,
        last_deploy_date,
        stop_date,
        dcomm_date,
        mod_date
      FROM customer_env
      WHERE org_key = ${org_key}
        AND env_key = ${env_key}
    `;

    if (!env) {
      return Response.json(
        { error: `Environment '${org_key}/${env_key}' not found` },
        { status: 404 }
      );
    }

    // Fetch deployment_log entries for this environment, newest first
    const logs = await sql<DeploymentLog[]>`
      SELECT
        deployment_log_id,
        log_org_key,
        log_env_key,
        action,
        status,
        error_detail,
        retry_count,
        created_date
      FROM deployment_log
      WHERE log_org_key = ${org_key}
        AND log_env_key = ${env_key}
      ORDER BY created_date DESC, deployment_log_id DESC
      LIMIT ${logLimit}
    `;

    // Compute the current retry count: MAX(retry_count) from 'retrying' entries
    // since the last 'success' entry.  Mirrors the logic in db-worker.getRetryCount
    // but without filtering by action so it covers any in-progress operation.
    const [retryRow] = await sql<{ current_retry_count: string }[]>`
      SELECT COALESCE(MAX(dl.retry_count), 0) AS current_retry_count
      FROM deployment_log dl
      WHERE dl.log_org_key = ${org_key}
        AND dl.log_env_key = ${env_key}
        AND dl.status = 'retrying'
        AND NOT EXISTS (
          SELECT 1
          FROM deployment_log dl2
          WHERE dl2.log_org_key = ${org_key}
            AND dl2.log_env_key = ${env_key}
            AND dl2.status      = 'success'
            AND dl2.created_date > dl.created_date
        )
    `;
    const currentRetryCount = parseInt(retryRow?.current_retry_count ?? '0', 10);

    const response: StatusResponse = {
      org_key: env.org_key,
      env_key: env.env_key,
      deploy_status: env.deploy_status,
      last_deploy_date: env.last_deploy_date,
      stop_date: env.stop_date,
      dcomm_date: env.dcomm_date,
      mod_date: env.mod_date,
      current_retry_count: currentRetryCount,
      logs,
    };

    return Response.json(response);
  } catch (err) {
    console.error(`[GET /api/envs/${org_key}/status?env_key=${env_key}] Database error:`, err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
