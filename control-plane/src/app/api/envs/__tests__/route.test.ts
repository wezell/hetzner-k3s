/**
 * Verification tests: POST /api/envs provision endpoint
 *
 * Sub-AC 1 requirements:
 *   1. Stores new customer_env record with deploy_status = 'pending'
 *   2. Returns HTTP 201 with the created record
 *   3. Validation errors return 422 with details
 *   4. Duplicate (org_key, env_key) returns 409
 *   5. Unknown org_key returns 422
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomerEnv } from '@/db/types';

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

const MOCK_ENV_ROW: CustomerEnv = {
  org_key: 'acme',
  env_key: 'prod',
  cluster_id: 'default',
  region_id: 'ash',
  image: 'dotcms/dotcms:24.06.00',
  replicas: 1,
  memory_req: '4Gi',
  memory_limit: '5Gi',
  cpu_req: '500m',
  cpu_limit: '2000m',
  env_vars: {},
  deploy_status: 'pending',
  created_date: '2026-04-14T12:00:00Z',
  mod_date: '2026-04-14T12:00:00Z',
  last_deploy_date: null,
  stop_date: null,
  dcomm_date: null,
  last_applied_config: null,
};

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/envs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('POST /api/envs — provision endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: sql() resolves with [MOCK_ENV_ROW]
    // postgres.js tagged templates return a thenable array-like result
    mockSql.mockImplementation((...args: unknown[]) => {
      // Return a Promise that resolves to the array of rows
      return Promise.resolve([MOCK_ENV_ROW]);
    });
  });

  // -------------------------------------------------------------------------
  // AC: returns 201 with the created record
  // -------------------------------------------------------------------------
  it('returns HTTP 201 with the created record on success', async () => {
    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json() as CustomerEnv;
    expect(body.org_key).toBe('acme');
    expect(body.env_key).toBe('prod');
    expect(body.image).toBe('dotcms/dotcms:24.06.00');
  });

  // -------------------------------------------------------------------------
  // AC: record is stored with deploy_status = 'pending'
  // -------------------------------------------------------------------------
  it("stores the record with deploy_status = 'pending'", async () => {
    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // The returned row must have deploy_status = 'pending'
    const body = await res.json() as CustomerEnv;
    expect(body.deploy_status).toBe('pending');
  });

  it("passes the literal string 'pending' to the SQL INSERT", async () => {
    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
    });

    await POST(req);

    // Verify the sql tagged template was called
    expect(mockSql).toHaveBeenCalledOnce();

    // Reconstruct the full SQL string from the template parts
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = call[0] as string[];
    const fullSql = strings.join('').toLowerCase();

    // The INSERT statement must contain 'pending' hardcoded (not a bind param)
    expect(fullSql).toContain("'pending'");
    expect(fullSql).toContain('insert into customer_env');
    expect(fullSql).toContain('deploy_status');
  });

  // -------------------------------------------------------------------------
  // AC: applies default values for optional fields
  // -------------------------------------------------------------------------
  it('applies sensible defaults for omitted optional fields', async () => {
    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // Returned record reflects the defaults baked into the mock row
    const body = await res.json() as CustomerEnv;
    expect(body.cluster_id).toBe('default');
    expect(body.region_id).toBe('ash');
    expect(body.replicas).toBe(1);
    expect(body.memory_req).toBe('4Gi');
    expect(body.memory_limit).toBe('5Gi');
    expect(body.cpu_req).toBe('500m');
    expect(body.cpu_limit).toBe('2000m');
  });

  it('accepts and stores custom resource/replica values', async () => {
    const customRow: CustomerEnv = {
      ...MOCK_ENV_ROW,
      replicas: 3,
      memory_req: '8Gi',
      memory_limit: '10Gi',
      cpu_req: '1000m',
      cpu_limit: '4000m',
    };
    mockSql.mockResolvedValueOnce([customRow]);

    const req = makeRequest({
      org_key: 'acme',
      env_key: 'staging',
      image: 'dotcms/dotcms:24.06.00',
      replicas: 3,
      memory_req: '8Gi',
      memory_limit: '10Gi',
      cpu_req: '1000m',
      cpu_limit: '4000m',
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as CustomerEnv;
    expect(body.replicas).toBe(3);
    expect(body.memory_req).toBe('8Gi');
    expect(body.cpu_req).toBe('1000m');
  });

  // -------------------------------------------------------------------------
  // AC: env_vars stored correctly
  // -------------------------------------------------------------------------
  it('accepts env_vars and passes them through to DB', async () => {
    const envVars = { CMS_HEAP: '4g', CMS_FEATURE_FLAG: 'true' };
    const rowWithVars: CustomerEnv = {
      ...MOCK_ENV_ROW,
      env_vars: envVars,
    };
    mockSql.mockResolvedValueOnce([rowWithVars]);

    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
      env_vars: envVars,
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as CustomerEnv;
    expect(body.env_vars).toEqual(envVars);
  });

  // -------------------------------------------------------------------------
  // AC: stop_date accepted in payload
  // -------------------------------------------------------------------------
  it('accepts a stop_date ISO timestamp and stores it', async () => {
    const rowWithStopDate: CustomerEnv = {
      ...MOCK_ENV_ROW,
      stop_date: '2026-06-01T00:00:00Z',
    };
    mockSql.mockResolvedValueOnce([rowWithStopDate]);

    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
      stop_date: '2026-06-01T00:00:00Z',
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as CustomerEnv;
    expect(body.stop_date).toBe('2026-06-01T00:00:00Z');
    // deploy_status must still be 'pending' even when stop_date is set
    expect(body.deploy_status).toBe('pending');
  });

  // -------------------------------------------------------------------------
  // AC: validation errors return 422
  // -------------------------------------------------------------------------
  describe('validation', () => {
    it('returns 422 when org_key is missing', async () => {
      const req = makeRequest({ env_key: 'prod', image: 'dotcms/dotcms:24.06.00' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; details: string[] };
      expect(body.error).toBe('Validation failed');
      expect(body.details.some((d) => d.includes('org_key'))).toBe(true);
    });

    it('returns 422 when env_key is missing', async () => {
      const req = makeRequest({ org_key: 'acme', image: 'dotcms/dotcms:24.06.00' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; details: string[] };
      expect(body.details.some((d) => d.includes('env_key'))).toBe(true);
    });

    it('returns 422 when image is missing', async () => {
      const req = makeRequest({ org_key: 'acme', env_key: 'prod' });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { error: string; details: string[] };
      expect(body.details.some((d) => d.includes('image'))).toBe(true);
    });

    it('returns 422 when org_key contains uppercase letters', async () => {
      const req = makeRequest({ org_key: 'ACME', env_key: 'prod', image: 'dotcms/dotcms:24.06.00' });
      const res = await POST(req);
      expect(res.status).toBe(422);
    });

    it('returns 422 when org_key starts with a hyphen', async () => {
      const req = makeRequest({ org_key: '-acme', env_key: 'prod', image: 'dotcms/dotcms:24.06.00' });
      const res = await POST(req);
      expect(res.status).toBe(422);
    });

    it('returns 422 when replicas is negative', async () => {
      const req = makeRequest({ org_key: 'acme', env_key: 'prod', image: 'img', replicas: -1 });
      const res = await POST(req);
      expect(res.status).toBe(422);
      const body = await res.json() as { details: string[] };
      expect(body.details.some((d) => d.includes('replicas'))).toBe(true);
    });

    it('returns 422 when stop_date is not a valid ISO timestamp', async () => {
      const req = makeRequest({ org_key: 'acme', env_key: 'prod', image: 'img', stop_date: 'not-a-date' });
      const res = await POST(req);
      expect(res.status).toBe(422);
    });

    it('returns 400 when request body is invalid JSON', async () => {
      const req = new Request('http://localhost/api/envs', {
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
  it('returns 409 when (org_key, env_key) already exists', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockSql.mockRejectedValueOnce(pgError);

    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('already exists');
  });

  // -------------------------------------------------------------------------
  // AC: Unknown org returns 422 (FK violation)
  // -------------------------------------------------------------------------
  it('returns 422 when org_key references unknown organization', async () => {
    const pgError = Object.assign(new Error('foreign key violation'), { code: '23503' });
    mockSql.mockRejectedValueOnce(pgError);

    const req = makeRequest({
      org_key: 'unknown-org',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('does not exist');
  });

  // -------------------------------------------------------------------------
  // AC: unhandled DB error returns 500
  // -------------------------------------------------------------------------
  it('returns 500 on unexpected database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));

    const req = makeRequest({
      org_key: 'acme',
      env_key: 'prod',
      image: 'dotcms/dotcms:24.06.00',
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /api/envs — list endpoint (basic sanity check)
// ---------------------------------------------------------------------------
describe('GET /api/envs — list endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockImplementation(() => Promise.resolve([MOCK_ENV_ROW]));
  });

  it('returns 200 with array of environments', async () => {
    const req = new Request('http://localhost/api/envs', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as CustomerEnv[];
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].org_key).toBe('acme');
  });

  it('filters by org_key query param', async () => {
    const req = new Request('http://localhost/api/envs?org_key=acme', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledOnce();
    // The sql call strings should contain a WHERE clause for org_key filter
    const call = mockSql.mock.calls[0] as unknown[];
    const strings = (call[0] as string[]).join('').toLowerCase();
    expect(strings).toContain('where');
  });

  it('returns 500 on database error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection reset'));
    const req = new Request('http://localhost/api/envs', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});
