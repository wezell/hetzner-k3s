/**
 * Tests: POST /api/envs/[id]/decommission endpoint
 *
 * AC 110102 requirements:
 *   1. POST sets dcomm_date = NOW() on the customer_env record
 *   2. Returns 200 with the updated record on success
 *   3. Returns 400 when env_key query param is missing
 *   4. Returns 404 when env not found
 *   5. Returns 409 when environment is already decommissioned
 *   6. Returns 500 on database error
 *   7. PATCH method also works (UI compatibility)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// Mock @/db so no live database is needed
// ---------------------------------------------------------------------------
const { mockSql } = vi.hoisted(() => {
  const mockSql = vi.fn();
  return { mockSql };
});

vi.mock('@/db', () => ({
  sql: mockSql,
  default: mockSql,
}));

// Import AFTER mocks
import { POST, PATCH } from '../[id]/decommission/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ENV: CustomerEnv = {
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
  deploy_status: 'deployed',
  created_date: '2026-04-14T12:00:00Z',
  mod_date: '2026-04-14T12:00:00Z',
  last_deploy_date: null,
  stop_date: null,
  dcomm_date: null,
  last_applied_config: null,
};

function makeRequest(
  orgKey: string,
  envKey: string | null,
  method: 'POST' | 'PATCH' = 'POST'
): Request {
  const url = envKey
    ? `http://localhost/api/envs/${orgKey}/decommission?env_key=${envKey}`
    : `http://localhost/api/envs/${orgKey}/decommission`;
  return new Request(url, { method });
}

function makeParams(orgKey: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: orgKey }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/envs/[id]/decommission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('success path', () => {
    it('sets dcomm_date and returns the updated env record (HTTP 200)', async () => {
      const updatedEnv: CustomerEnv = {
        ...BASE_ENV,
        dcomm_date: '2026-04-14T13:00:00Z',
        mod_date: '2026-04-14T13:00:00Z',
      };

      // First sql call: UPDATE RETURNING * → returns the updated row
      mockSql.mockResolvedValueOnce([updatedEnv]);

      const res = await POST(makeRequest('acme', 'prod'), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.org_key).toBe('acme');
      expect(body.env_key).toBe('prod');
      expect(body.dcomm_date).toBe('2026-04-14T13:00:00Z');
    });

    it('works for a stopped environment (any non-decommissioned state)', async () => {
      const stoppedEnv: CustomerEnv = {
        ...BASE_ENV,
        deploy_status: 'stopped',
        stop_date: '2026-04-14T10:00:00Z',
        dcomm_date: '2026-04-14T13:00:00Z',
      };

      mockSql.mockResolvedValueOnce([stoppedEnv]);

      const res = await POST(makeRequest('acme', 'prod'), makeParams('acme'));
      expect(res.status).toBe(200);
    });

    it('works for a failed environment', async () => {
      const failedEnv: CustomerEnv = {
        ...BASE_ENV,
        deploy_status: 'failed',
        dcomm_date: '2026-04-14T13:00:00Z',
      };

      mockSql.mockResolvedValueOnce([failedEnv]);

      const res = await POST(makeRequest('acme', 'prod'), makeParams('acme'));
      expect(res.status).toBe(200);
    });
  });

  describe('validation errors', () => {
    it('returns 400 when env_key is missing', async () => {
      const res = await POST(makeRequest('acme', null), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/env_key/i);
    });
  });

  describe('not found', () => {
    it('returns 404 when the environment does not exist', async () => {
      // First sql: UPDATE returns nothing (no match)
      mockSql.mockResolvedValueOnce([]);
      // Second sql: SELECT also returns nothing (env doesn't exist)
      mockSql.mockResolvedValueOnce([]);

      const res = await POST(makeRequest('acme', 'ghost'), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('conflict', () => {
    it('returns 409 when environment is already decommissioned', async () => {
      // First sql: UPDATE returns nothing (status is 'decommissioned', guard rejects)
      mockSql.mockResolvedValueOnce([]);
      // Second sql: SELECT returns the decommissioned row
      mockSql.mockResolvedValueOnce([
        { org_key: 'acme', env_key: 'prod', deploy_status: 'decommissioned' },
      ]);

      const res = await POST(makeRequest('acme', 'prod'), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toMatch(/already decommissioned/i);
    });
  });

  describe('database error', () => {
    it('returns 500 on unexpected database failure', async () => {
      mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await POST(makeRequest('acme', 'prod'), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });
});

describe('PATCH /api/envs/[id]/decommission (UI compatibility alias)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PATCH is exported and works identically to POST', async () => {
    const updatedEnv: CustomerEnv = {
      ...BASE_ENV,
      dcomm_date: '2026-04-14T13:00:00Z',
    };

    mockSql.mockResolvedValueOnce([updatedEnv]);

    const res = await PATCH(makeRequest('acme', 'prod', 'PATCH'), makeParams('acme'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.dcomm_date).toBe('2026-04-14T13:00:00Z');
  });

  it('PATCH returns 409 for already-decommissioned environments', async () => {
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([
      { org_key: 'acme', env_key: 'prod', deploy_status: 'decommissioned' },
    ]);

    const res = await PATCH(makeRequest('acme', 'prod', 'PATCH'), makeParams('acme'));
    expect(res.status).toBe(409);
  });
});

describe('atomic UPDATE guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not double-decommission: UPDATE WHERE deploy_status != decommissioned', async () => {
    // Simulate the guard rejecting an already-decommissioned env
    mockSql.mockResolvedValueOnce([]); // UPDATE matched nothing
    mockSql.mockResolvedValueOnce([
      { org_key: 'acme', env_key: 'prod', deploy_status: 'decommissioned' },
    ]);

    const res = await POST(makeRequest('acme', 'prod'), makeParams('acme'));
    expect(res.status).toBe(409);

    // Verify sql was called exactly twice (UPDATE then SELECT fallback)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('only calls DB once on successful decommission scheduling', async () => {
    mockSql.mockResolvedValueOnce([{ ...BASE_ENV, dcomm_date: new Date().toISOString() }]);

    await POST(makeRequest('acme', 'prod'), makeParams('acme'));

    // Only the UPDATE query should run — no fallback SELECT needed
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
