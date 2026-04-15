import { sql } from '@/db';
import type { DeploymentLog } from '@/db/types';

// ---------------------------------------------------------------------------
// GET /api/envs/[id]/[env]/logs/latest
//
// Returns the single most-recent deployment_log entry for a given environment.
//
// Route params:
//   id  — the org_key for the environment's parent organization
//   env — the env_key for the environment
//
// Response (200):
//   {
//     org_key: string,
//     env_key: string,
//     log: DeploymentLog | null,   // null when no log entries exist yet
//   }
//
// Response (404):
//   { error: string }   — when the environment itself does not exist
//
// Example:
//   GET /api/envs/acme/prod/logs/latest
// ---------------------------------------------------------------------------

interface LatestLogResponse {
  org_key: string;
  env_key: string;
  log: DeploymentLog | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; env: string }> }
): Promise<Response> {
  const { id: org_key, env: env_key } = await params;

  if (!org_key || typeof org_key !== 'string') {
    return Response.json(
      { error: 'org_key path parameter is required' },
      { status: 400 }
    );
  }

  if (!env_key || typeof env_key !== 'string') {
    return Response.json(
      { error: 'env_key path parameter is required' },
      { status: 400 }
    );
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

    // Fetch the single latest log entry
    const [latestLog] = await sql<DeploymentLog[]>`
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
      LIMIT 1
    `;

    const response: LatestLogResponse = {
      org_key,
      env_key,
      log: latestLog ?? null,
    };

    return Response.json(response);
  } catch (err) {
    console.error(
      `[GET /api/envs/${org_key}/${env_key}/logs/latest] Database error:`,
      err
    );
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
