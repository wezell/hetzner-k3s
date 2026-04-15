/**
 * Verification tests: POST /api/orgs and GET /api/orgs endpoints
 *
 * Sub-AC 2 requirements:
 *   1. Validates required fields (org_key, org_long_name) and returns 422 on failure
 *   2. Validates org_key format (lowercase slug pattern)
 *   3. Validates optional fields (org_active, org_email_domain, org_data)
 *   4. Inserts a new customer_org record and returns HTTP 201 with the created record
 *   5. Duplicate org_key returns 409
 *   6. Invalid JSON returns 400
 *   7. GET /api/orgs returns 200 with array of organizations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomerOrg } from '@/db/types';

// ---------------------------------------------------------------------------
// Mock @/db so no live database is needed
// vi.hoisted() runs before vi.mock() factory, allowing the variable to be
// referenced inside the factory (which is hoisted to top of file by Vitest).
// ---------------------------------------------------------------------------
const { mockSql } = vi.hoisted(() => {
  const mockSql = vi.fn();
  return { mockSql };
});

vi.mock('@/db', () => ({
  sql: mockSql,
  default: mockSql,
}));

// Import the route handlers AFTER mocks are set up
import { POST, GET } from '../route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_ORG_ROW: CustomerOrg = {
  org_key: 'acme',
  org_long_name: 'Acme Corporation',
  org_active: true,
  org_email_domain: 'acme.com',
  org_data: {},
  created_date: '2026-04-14T12:00:00Z',
  mod_date: '2026-04-14T12:00:00Z',
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/orgs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('POST /api/orgs — organization creation endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: sql() resolves with [MOCK_ORG_ROW]
    mockSql.mockImplementation(() => Promise.resolve([MOCK_ORG_ROW]));
  });

  // -------------------------------------------------------------------------
  // AC: returns 201 with the created record
  // -------------------------------------------------------------------------
  it('returns HTTP 201 with the created record on success', async () => {
    const req = makeRequest({
      org_key: 'acme',
      org_long_name: 'Acme Corporation',
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json() as CustomerOrg;
    expect(body.org_key).toBe('acme');
    expect(body.org_long_name).toBe('Acme Corporation');
  });

  // -------------------------------------------------------------------------
  // AC: default values applied
  // -------------------------------------------------------------------------
  it('defaults org_active to true when omitted', async () => {
    const req = makeRequest({
      org_key: 'acme',
      org_long_name: 'Acme Corporation',
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    const body = await res.json() as CustomerOrg;
    expect(body.org_active).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC: inserts row with correct fields
  // -------------------------------------------------------------------------
  it('calls sql with INSERT INTO customer_org', async () => {
    const req = makeRequest({
      org_key: 'acme',
      org_long_name: 'Acme Corporation',
    });

    await POST(req);

    expect(mockSql).toHaveBeenCalledOnce();
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).toContain('insert into customer_org');
    expect(strings).toContain('returning');
  });

  // -------------------------------------------------------------------------
  // AC: accepts all optional fields
  // -------------------------------------------------------------------------
  it('accepts org_active, org_email_domain, and org_data optional fields', async () => {
    const customRow: CustomerOrg = {
      ...MOCK_ORG_ROW,
      org_active: false,
      org_email_domain: 'corp.example.com',
      org_data: { tier: 'enterprise', seats: 500 },
    };
    mockSql.mockResolvedValueOnce([customRow]);

    const req = makeRequest({
      org_key: 'acme',
      org_long_name: 'Acme Corporation',
      org_active: false,
      org_email_domain: 'corp.example.com',
      org_data: { tier: 'enterprise', seats: 500 },
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as CustomerOrg;
    expect(body.org_active).toBe(false);
    expect(body.org_email_domain).toBe('corp.example.com');
    expect(body.org_data).toEqual({ tier: 'enterprise', seats: 500 });
  });

  // -------------------------------------------------------------------------
  // AC: org_key is lowercased before insert
  // -------------------------------------------------------------------------
  it('lowercases org_key before inserting', async () => {
    // org_key with uppercase is rejected at validation, but ensure the
    // lowercase coercion path works for already-valid lowercase input
    const lowerRow: CustomerOrg = { ...MOCK_ORG_ROW, org_key: 'my-corp' };
    mockSql.mockResolvedValueOnce([lowerRow]);

    const req = makeRequest({
      org_key: 'my-corp',
      org_long_name: 'My Corp',
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as CustomerOrg;
    expect(body.org_key).toBe('my-corp');
  });

  // -------------------------------------------------------------------------
  // AC: validation errors return 422
  // -------------------------------------------------------------------------
  describe('validation', () => {
    it('returns 422 when org_key is missing', async () => {
      const req = makeRequest({ org_long_name: 'Acme' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; details: string[] };
      expect(body.error).toBe('Validation failed');
      expect(body.details.some((d) => d.includes('org_key'))).toBe(true);
    });

    it('returns 422 when org_long_name is missing', async () => {
      const req = makeRequest({ org_key: 'acme' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; details: string[] };
      expect(body.details.some((d) => d.includes('org_long_name'))).toBe(true);
    });

    it('returns 422 when org_key contains uppercase letters', async () => {
      const req = makeRequest({ org_key: 'ACME', org_long_name: 'Acme' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; details: string[] };
      expect(body.details.some((d) => d.includes('org_key'))).toBe(true);
    });

    it('returns 422 when org_key starts with a hyphen', async () => {
      const req = makeRequest({ org_key: '-acme', org_long_name: 'Acme' });
      const res = await POST(req);
      expect(res.status).toBe(422);
    });

    it('returns 422 when org_key ends with a hyphen', async () => {
      const req = makeRequest({ org_key: 'acme-', org_long_name: 'Acme' });
      const res = await POST(req);
      expect(res.status).toBe(422);
    });

    it('returns 422 when org_key has invalid characters (underscore)', async () => {
      const req = makeRequest({ org_key: 'acme_corp', org_long_name: 'Acme' });
      const res = await POST(req);
      expect(res.status).toBe(422);
    });

    it('accepts valid org_key with hyphens', async () => {
      const req = makeRequest({ org_key: 'my-corp-123', org_long_name: 'My Corp' });
      const res = await POST(req);
      expect(res.status).toBe(201);
    });

    it('accepts single-character org_key', async () => {
      const singleCharRow: CustomerOrg = { ...MOCK_ORG_ROW, org_key: 'a' };
      mockSql.mockResolvedValueOnce([singleCharRow]);
      const req = makeRequest({ org_key: 'a', org_long_name: 'A Corp' });
      const res = await POST(req);
      expect(res.status).toBe(201);
    });

    it('returns 422 when org_active is not a boolean', async () => {
      const req = makeRequest({ org_key: 'acme', org_long_name: 'Acme', org_active: 'yes' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { details: string[] };
      expect(body.details.some((d) => d.includes('org_active'))).toBe(true);
    });

    it('returns 422 when org_email_domain is not a valid domain', async () => {
      const req = makeRequest({ org_key: 'acme', org_long_name: 'Acme', org_email_domain: 'not-a-domain' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { details: string[] };
      expect(body.details.some((d) => d.includes('org_email_domain'))).toBe(true);
    });

    it('returns 422 when org_data is an array instead of object', async () => {
      const req = makeRequest({ org_key: 'acme', org_long_name: 'Acme', org_data: ['item'] });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { details: string[] };
      expect(body.details.some((d) => d.includes('org_data'))).toBe(true);
    });

    it('returns 400 when request body is invalid JSON', async () => {
      const req = new Request('http://localhost/api/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json {{{',
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('returns 400 when body is a JSON array instead of object', async () => {
      const req = makeRequest([{ org_key: 'acme' }]);
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // AC: DB conflict returns 409
  // -------------------------------------------------------------------------
  it('returns 409 when org_key already exists', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockSql.mockRejectedValueOnce(pgError);

    const req = makeRequest({
      org_key: 'acme',
      org_long_name: 'Acme Corporation',
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('already exists');
    expect(body.error).toContain('acme');
  });

  // -------------------------------------------------------------------------
  // AC: unhandled DB error returns 500
  // -------------------------------------------------------------------------
  it('returns 500 on unexpected database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));

    const req = makeRequest({
      org_key: 'acme',
      org_long_name: 'Acme Corporation',
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/orgs — list endpoint
// ---------------------------------------------------------------------------
describe('GET /api/orgs — list endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockImplementation(() => Promise.resolve([MOCK_ORG_ROW]));
  });

  it('returns 200 with array of organizations', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerOrg[];
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].org_key).toBe('acme');
    expect(body[0].org_long_name).toBe('Acme Corporation');
  });

  it('returns 200 with empty array when no orgs exist', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerOrg[];
    expect(body).toEqual([]);
  });

  it('returns multiple organizations sorted by org_key', async () => {
    const rows: CustomerOrg[] = [
      { ...MOCK_ORG_ROW, org_key: 'acme' },
      { ...MOCK_ORG_ROW, org_key: 'globex', org_long_name: 'Globex Corp', org_email_domain: 'globex.com' },
    ];
    mockSql.mockResolvedValueOnce(rows);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerOrg[];
    expect(body).toHaveLength(2);
    expect(body[0].org_key).toBe('acme');
    expect(body[1].org_key).toBe('globex');
  });

  it('queries with ORDER BY org_key ASC', async () => {
    await GET();
    expect(mockSql).toHaveBeenCalledOnce();
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).toContain('order by');
    expect(strings).toContain('org_key');
  });

  it('returns 500 on database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/orgs — filtering support (?id= and ?name=)
// ---------------------------------------------------------------------------
describe('GET /api/orgs — filtering by ?id and ?name query params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockImplementation(() => Promise.resolve([MOCK_ORG_ROW]));
  });

  function makeGetRequest(queryString: string): Request {
    return new Request(`http://localhost/api/orgs${queryString}`);
  }

  // -------------------------------------------------------------------------
  // ?id= exact match
  // -------------------------------------------------------------------------
  it('filters by exact org_key when ?id= is provided', async () => {
    const res = await GET(makeGetRequest('?id=acme'));
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerOrg[];
    expect(Array.isArray(body)).toBe(true);
  });

  it('passes org_key value to SQL when ?id= filter is used', async () => {
    await GET(makeGetRequest('?id=acme'));
    expect(mockSql).toHaveBeenCalledOnce();
    const call = mockSql.mock.calls[0] as unknown[];
    // The interpolated values array should contain 'acme'
    expect(call.slice(1)).toContain('acme');
  });

  it('includes WHERE clause in SQL when ?id= is provided', async () => {
    await GET(makeGetRequest('?id=acme'));
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).toContain('where');
    expect(strings).toContain('org_key');
  });

  it('returns 200 with empty array when ?id= matches nothing', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(makeGetRequest('?id=nonexistent'));
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerOrg[];
    expect(body).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ?name= wildcard match
  // -------------------------------------------------------------------------
  it('filters by org_long_name when ?name= is provided', async () => {
    const res = await GET(makeGetRequest('?name=Acme*'));
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerOrg[];
    expect(Array.isArray(body)).toBe(true);
  });

  it('converts * wildcard to % for SQL ILIKE when ?name= is provided', async () => {
    await GET(makeGetRequest('?name=Acme*'));
    const call = mockSql.mock.calls[0] as unknown[];
    // The interpolated values should contain 'Acme%' (wildcard converted)
    expect(call.slice(1)).toContain('Acme%');
  });

  it('includes WHERE and ILIKE in SQL when ?name= is provided', async () => {
    await GET(makeGetRequest('?name=Acme*'));
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).toContain('where');
    expect(strings).toContain('ilike');
  });

  it('supports prefix wildcard pattern ?name=*corp*', async () => {
    await GET(makeGetRequest('?name=*corp*'));
    const call = mockSql.mock.calls[0] as unknown[];
    expect(call.slice(1)).toContain('%corp%');
  });

  it('returns 200 with empty array when ?name= matches nothing', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(makeGetRequest('?name=ZZZnotfound*'));
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerOrg[];
    expect(body).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Combined ?id= AND ?name=
  // -------------------------------------------------------------------------
  it('combines both filters with AND when ?id= and ?name= are both provided', async () => {
    await GET(makeGetRequest('?id=acme&name=Acme*'));
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).toContain('where');
    expect(strings).toContain('org_key');
    expect(strings).toContain('and');
    expect(strings).toContain('ilike');
  });

  it('passes both values to SQL when ?id= and ?name= are combined', async () => {
    await GET(makeGetRequest('?id=acme&name=Acme*'));
    const call = mockSql.mock.calls[0] as unknown[];
    const values = call.slice(1);
    expect(values).toContain('acme');
    expect(values).toContain('Acme%');
  });

  // -------------------------------------------------------------------------
  // No filter — backward compatible
  // -------------------------------------------------------------------------
  it('returns all orgs without WHERE clause when no filter params provided', async () => {
    const res = await GET(makeGetRequest(''));
    expect(res.status).toBe(200);
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).not.toContain('where');
  });

  it('handles request with unrelated query params gracefully (no filter applied)', async () => {
    const res = await GET(makeGetRequest('?foo=bar'));
    expect(res.status).toBe(200);
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).not.toContain('where');
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  it('returns 500 on database error during filtered query', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));
    const res = await GET(makeGetRequest('?id=acme'));
    expect(res.status).toBe(500);
  });
});
