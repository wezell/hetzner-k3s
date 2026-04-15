import { sql } from '@/db';
import type { CustomerOrg } from '@/db/types';

// ---------------------------------------------------------------------------
// DELETE /api/orgs/[id]
//
// Permanently deletes an organization and all its decommissioned environments.
//
// Blocked (409) if any environments exist that are NOT in 'decommissioned'
// status — the caller must decommission them first.
//
// On success: deletes deployment_logs → envs → org (FK order), returns 204.
// ---------------------------------------------------------------------------
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: org_key } = await params;

  if (!org_key) {
    return Response.json({ error: 'org_key path parameter is required' }, { status: 400 });
  }

  try {
    // Block if any live (non-decommissioned) envs remain
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count
      FROM customer_env
      WHERE org_key = ${org_key}
        AND deploy_status != 'decommissioned'
    `;

    if (parseInt(count, 10) > 0) {
      return Response.json(
        {
          error: `Organization '${org_key}' has ${count} active environment(s). Decommission all environments before deleting the organization.`,
        },
        { status: 409 },
      );
    }

    // Delete in FK order: logs → envs → org
    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM deployment_log
        WHERE log_org_key = ${org_key}
      `;
      await tx`
        DELETE FROM customer_env
        WHERE org_key = ${org_key}
      `;
      const result = await tx`
        DELETE FROM customer_org
        WHERE org_key = ${org_key}
      `;
      if (result.count === 0) throw new Error('not_found');
    });

    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && err.message === 'not_found') {
      return Response.json({ error: `Organization '${org_key}' not found` }, { status: 404 });
    }
    console.error(`[DELETE /api/orgs/${org_key}] Error:`, err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/orgs/[id] — update an existing customer_org record
// ---------------------------------------------------------------------------
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: org_key } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const errors: string[] = [];
  const updates: Record<string, unknown> = {};

  if ('org_long_name' in input) {
    if (!input.org_long_name || typeof input.org_long_name !== 'string') {
      errors.push('org_long_name must be a non-empty string');
    } else {
      updates.org_long_name = input.org_long_name.trim();
    }
  }

  if ('org_active' in input) {
    if (typeof input.org_active !== 'boolean') {
      errors.push('org_active must be a boolean');
    } else {
      updates.org_active = input.org_active;
    }
  }

  if ('org_email_domain' in input) {
    const domain = input.org_email_domain;
    if (domain === null || domain === '' || domain === undefined) {
      updates.org_email_domain = '';
    } else if (typeof domain !== 'string') {
      errors.push('org_email_domain must be a string or null');
    } else if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain.toLowerCase()) || !domain.includes('.')) {
      errors.push('org_email_domain must be a valid domain (e.g. example.com)');
    } else {
      updates.org_email_domain = domain.toLowerCase();
    }
  }

  if ('org_data' in input) {
    if (typeof input.org_data !== 'object' || Array.isArray(input.org_data) || input.org_data === null) {
      errors.push('org_data must be a JSON object');
    } else {
      updates.org_data = input.org_data;
    }
  }

  if (errors.length > 0) {
    return Response.json({ error: 'Validation failed', details: errors }, { status: 422 });
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 });
  }

  const longName = (updates.org_long_name ?? null) as string | null;
  const active = (updates.org_active ?? null) as boolean | null;
  const emailDomain = (updates.org_email_domain ?? null) as string | null;
  const orgData = updates.org_data ? JSON.stringify(updates.org_data) : null;

  try {
    const rows = await sql<CustomerOrg[]>`
      UPDATE customer_org
      SET
        org_long_name    = CASE WHEN ${longName} IS NOT NULL THEN ${longName} ELSE org_long_name END,
        org_active       = CASE WHEN ${active} IS NOT NULL THEN ${active} ELSE org_active END,
        org_email_domain = CASE WHEN ${emailDomain} IS NOT NULL THEN ${emailDomain} ELSE org_email_domain END,
        org_data         = CASE WHEN ${orgData}::jsonb IS NOT NULL THEN ${orgData}::jsonb ELSE org_data END,
        mod_date         = NOW()
      WHERE org_key = ${org_key}
      RETURNING *
    `;
    const [updated] = rows;

    if (!updated) {
      return Response.json({ error: `Organization '${org_key}' not found` }, { status: 404 });
    }

    return Response.json(updated);
  } catch (err) {
    console.error('[PATCH /api/orgs/:id] Database error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
