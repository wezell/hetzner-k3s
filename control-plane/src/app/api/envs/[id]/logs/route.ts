import { sql } from '@/db';
import type { DeploymentLog, LogAction, LogStatus } from '@/db/types';

// ---------------------------------------------------------------------------
// GET /api/envs/[id]/logs
//
// Returns deployment_log entries for a given environment, sorted newest-first.
// Supports filtering by action and/or status, and cursor-based pagination via
// `before_id` (the deployment_log_id of the oldest entry from the prior page).
//
// Route params:
//   id  — the org_key for the environment's parent organization
//
// Query params:
//   env_key   (required)  — the environment key within the organization
//   limit     (optional)  — max entries to return, 1–500, default 50
//   before_id (optional)  — cursor: only return entries with deployment_log_id
//                           less than this value (for keyset pagination)
//   action    (optional)  — filter by LogAction: provision|patch|stop|decommission
//   status    (optional)  — filter by LogStatus: success|failed|retrying
//
// Response:
//   {
//     org_key: string,
//     env_key: string,
//     logs: DeploymentLog[],       // newest first
//     total: number,               // total matching rows (ignoring pagination)
//     has_more: boolean,           // true when more pages remain
//   }
//
// Example:
//   GET /api/envs/acme/logs?env_key=prod
//   GET /api/envs/acme/logs?env_key=prod&limit=10&action=provision
//   GET /api/envs/acme/logs?env_key=prod&limit=10&before_id=99
// ---------------------------------------------------------------------------

const VALID_ACTIONS: readonly LogAction[] = ['provision', 'patch', 'stop', 'decommission'];
const VALID_STATUSES: readonly LogStatus[] = ['success', 'failed', 'retrying'];

interface LogsResponse {
  org_key: string;
  env_key: string;
  logs: DeploymentLog[];
  /** Total matching rows across all pages (ignores before_id cursor). */
  total: number;
  /** True when there are additional older entries beyond the current page. */
  has_more: boolean;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: org_key } = await params;
  const { searchParams } = new URL(request.url);

  const env_key = searchParams.get('env_key');
  const limitParam = searchParams.get('limit');
  const beforeIdParam = searchParams.get('before_id');
  const actionParam = searchParams.get('action');
  const statusParam = searchParams.get('status');

  // --- Validate path param ---
  if (!org_key || typeof org_key !== 'string') {
    return Response.json(
      { error: 'org_key path parameter is required' },
      { status: 400 }
    );
  }

  // --- Validate required query params ---
  if (!env_key) {
    return Response.json(
      { error: 'env_key query parameter is required' },
      { status: 400 }
    );
  }

  // --- Validate limit ---
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

  // --- Validate before_id cursor ---
  let beforeId: number | null = null;
  if (beforeIdParam !== null) {
    const parsed = parseInt(beforeIdParam, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      return Response.json(
        { error: 'before_id must be a positive integer' },
        { status: 400 }
      );
    }
    beforeId = parsed;
  }

  // --- Validate action filter ---
  let actionFilter: string | null = null;
  if (actionParam !== null) {
    if (!VALID_ACTIONS.includes(actionParam as LogAction)) {
      return Response.json(
        { error: `action must be one of: ${VALID_ACTIONS.join(', ')}` },
        { status: 400 }
      );
    }
    actionFilter = actionParam;
  }

  // --- Validate status filter ---
  let statusFilter: string | null = null;
  if (statusParam !== null) {
    if (!VALID_STATUSES.includes(statusParam as LogStatus)) {
      return Response.json(
        { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }
    statusFilter = statusParam;
  }

  try {
    // Verify the environment exists
    const [envExists] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1
        FROM customer_env
        WHERE org_key = ${org_key}
          AND env_key = ${env_key}
      ) AS exists
    `;

    if (!envExists?.exists) {
      return Response.json(
        { error: `Environment '${org_key}/${env_key}' not found` },
        { status: 404 }
      );
    }

    // Fetch paginated log entries (newest first).
    // Optional filters use nullable parameters:
    //   ($param::text IS NULL OR column = $param)
    // so when $param is NULL the condition is bypassed entirely — no fragments needed.
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
        AND (${beforeId}::int IS NULL OR deployment_log_id < ${beforeId}::int)
        AND (${actionFilter}::text IS NULL OR action = ${actionFilter}::text)
        AND (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
      ORDER BY created_date DESC, deployment_log_id DESC
      LIMIT ${logLimit}
    `;

    // Count total matching rows (ignoring cursor — useful for UI pagination indicators)
    const [countRow] = await sql<{ total: string }[]>`
      SELECT COUNT(*) AS total
      FROM deployment_log
      WHERE log_org_key = ${org_key}
        AND log_env_key = ${env_key}
        AND (${actionFilter}::text IS NULL OR action = ${actionFilter}::text)
        AND (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
    `;

    const total = parseInt(countRow?.total ?? '0', 10);

    // has_more: true when the oldest entry in this page is NOT the oldest
    // overall row matching the filters.  We detect this by checking whether
    // any row has a smaller deployment_log_id than the last entry returned.
    let has_more = false;
    if (logs.length === logLimit) {
      const oldest = logs[logs.length - 1];
      const [moreRow] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1
          FROM deployment_log
          WHERE log_org_key = ${org_key}
            AND log_env_key = ${env_key}
            AND deployment_log_id < ${oldest.deployment_log_id}
            AND (${actionFilter}::text IS NULL OR action = ${actionFilter}::text)
            AND (${statusFilter}::text IS NULL OR status = ${statusFilter}::text)
        ) AS exists
      `;
      has_more = moreRow?.exists ?? false;
    }

    const response: LogsResponse = {
      org_key,
      env_key,
      logs,
      total,
      has_more,
    };

    return Response.json(response);
  } catch (err) {
    console.error(
      `[GET /api/envs/${org_key}/logs?env_key=${env_key}] Database error:`,
      err
    );
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
