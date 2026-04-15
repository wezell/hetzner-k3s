import { sql } from '@/db';
import type { CustomerOrg, CreateCustomerOrg } from '@/db/types';

// ---------------------------------------------------------------------------
// POST /api/orgs — create a new customer_org record
// ---------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  // Validate required fields
  const errors: string[] = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const input = body as Record<string, unknown>;

  if (!input.org_key || typeof input.org_key !== 'string') {
    errors.push('org_key is required and must be a string');
  } else if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input.org_key as string)) {
    errors.push('org_key must be lowercase letters, numbers, and hyphens (1–63 chars), starting and ending with a letter or number');
  }

  if (!input.org_long_name || typeof input.org_long_name !== 'string') {
    errors.push('org_long_name is required and must be a string');
  }

  if (typeof input.org_active !== 'boolean') {
    // Accept omission — default to true
    if (input.org_active !== undefined) {
      errors.push('org_active must be a boolean');
    }
  }

  if (input.org_email_domain !== undefined && input.org_email_domain !== null && input.org_email_domain !== '') {
    if (typeof input.org_email_domain !== 'string') {
      errors.push('org_email_domain must be a string');
    } else if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test((input.org_email_domain as string).toLowerCase()) || !(input.org_email_domain as string).includes('.')) {
      errors.push('org_email_domain must be a valid domain (e.g. example.com)');
    }
  }

  if (input.org_data !== undefined && (typeof input.org_data !== 'object' || Array.isArray(input.org_data))) {
    errors.push('org_data must be a JSON object');
  }

  if (errors.length > 0) {
    return Response.json({ error: 'Validation failed', details: errors }, { status: 422 });
  }

  const payload: CreateCustomerOrg = {
    org_key: (input.org_key as string).toLowerCase(),
    org_long_name: input.org_long_name as string,
    org_active: typeof input.org_active === 'boolean' ? input.org_active : true,
    org_email_domain: input.org_email_domain ? (input.org_email_domain as string).toLowerCase() : '',
    org_data: (input.org_data as Record<string, unknown>) ?? {},
  };

  try {
    const [created] = await sql<CustomerOrg[]>`
      INSERT INTO customer_org (
        org_key,
        org_long_name,
        org_active,
        org_email_domain,
        org_data
      ) VALUES (
        ${payload.org_key},
        ${payload.org_long_name},
        ${payload.org_active},
        ${payload.org_email_domain},
        ${JSON.stringify(payload.org_data ?? {})}
      )
      RETURNING *
    `;
    return Response.json(created, { status: 201 });
  } catch (err: unknown) {
    // Postgres unique_violation = code 23505
    if (isPostgresError(err) && err.code === '23505') {
      return Response.json(
        { error: `Organization with org_key '${payload.org_key}' already exists` },
        { status: 409 }
      );
    }
    console.error('[POST /api/orgs] Database error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/orgs — list customer_org records with optional filtering
//
// Query parameters (all optional):
//   ?q=<term>        — unified search: matches org_key OR org_long_name
//                      (case-insensitive, substring match on both columns)
//
// Legacy params still supported for backwards compatibility:
//   ?id=<org_key>    — exact match on org_key
//   ?name=<pattern>  — wildcard match on org_long_name (use * as wildcard)
// ---------------------------------------------------------------------------
export async function GET(request?: Request): Promise<Response> {
  try {
    const url = request ? new URL(request.url) : null;
    const q = url?.searchParams.get('q') ?? null;
    const idFilter = url?.searchParams.get('id') ?? null;
    const nameFilter = url?.searchParams.get('name') ?? null;

    let orgs: CustomerOrg[];

    if (q !== null) {
      // Unified search: matches org_key OR org_long_name (substring, case-insensitive)
      // Escape ILIKE metacharacters so user input like '%' or '_' is treated literally
      const escaped = q.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escaped}%`;
      orgs = await sql<CustomerOrg[]>`
        SELECT * FROM customer_org
        WHERE org_key ILIKE ${pattern}
           OR org_long_name ILIKE ${pattern}
        ORDER BY mod_date DESC, org_key ASC
      `;
    } else if (idFilter !== null && nameFilter !== null) {
      const namePattern = nameFilter.replace(/\*/g, '%');
      orgs = await sql<CustomerOrg[]>`
        SELECT * FROM customer_org
        WHERE org_key = ${idFilter}
          AND org_long_name ILIKE ${namePattern}
        ORDER BY mod_date DESC, org_key ASC
      `;
    } else if (idFilter !== null) {
      orgs = await sql<CustomerOrg[]>`
        SELECT * FROM customer_org
        WHERE org_key = ${idFilter}
        ORDER BY mod_date DESC, org_key ASC
      `;
    } else if (nameFilter !== null) {
      const namePattern = nameFilter.replace(/\*/g, '%');
      orgs = await sql<CustomerOrg[]>`
        SELECT * FROM customer_org
        WHERE org_long_name ILIKE ${namePattern}
        ORDER BY mod_date DESC, org_key ASC
      `;
    } else {
      orgs = await sql<CustomerOrg[]>`
        SELECT * FROM customer_org
        ORDER BY mod_date DESC, org_key ASC
      `;
    }

    return Response.json(orgs);
  } catch (err) {
    console.error('[GET /api/orgs] Database error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface PostgresError {
  code: string;
  message: string;
}

function isPostgresError(err: unknown): err is PostgresError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  );
}
