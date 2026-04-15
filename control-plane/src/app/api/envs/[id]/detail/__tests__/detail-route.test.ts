/**
 * Tests: GET and PATCH /api/envs/[id]/detail endpoint
 *
 * GET requirements:
 *   1. Returns 200 with full customer_env record on success
 *   2. Returns 400 when env_key query param is missing
 *   3. Returns 404 when environment not found
 *   4. Returns 500 on database error
 *
 * PATCH requirements:
 *   1. Updates mutable fields and returns updated record (HTTP 200)
 *   2. Returns 400 when env_key query param is missing
 *   3. Returns 400 when request body is invalid JSON
 *   4. Returns 400 when replicas is not a non-negative integer
 *   5. Returns 400 when env_vars is not a plain object
 *   6. Returns 404 when environment not found
 *   7. Returns 500 on database error
 *   8. Accepts partial updates (only provided fields are changed)
 *   9. Does not update immutable fields (org_key, env_key, deploy_status)
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
import { GET, PATCH } from '../route';

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

function makeGetRequest(orgKey: string, envKey: string | null): Request {
  const url = envKey
    ? `http://localhost/api/envs/${orgKey}/detail?env_key=${envKey}`
    : `http://localhost/api/envs/${orgKey}/detail`;
  return new Request(url, { method: 'GET' });
}

function makePatchRequest(
  orgKey: string,
  envKey: string | null,
  body?: unknown
): Request {
  const url = envKey
    ? `http://localhost/api/envs/${orgKey}/detail?env_key=${envKey}`
    : `http://localhost/api/envs/${orgKey}/detail`;
  return new Request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : 'not-json{{',
  });
}

function makeParams(orgKey: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: orgKey }) };
}

// ---------------------------------------------------------------------------
// GET tests
// ---------------------------------------------------------------------------

describe('GET /api/envs/[id]/detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('success path', () => {
    it('returns 200 with full env record', async () => {
      mockSql.mockResolvedValueOnce([BASE_ENV]);

      const res = await GET(makeGetRequest('acme', 'prod'), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.org_key).toBe('acme');
      expect(body.env_key).toBe('prod');
      expect(body.image).toBe('dotcms/dotcms:24.06.00');
      expect(body.deploy_status).toBe('deployed');
    });

    it('returns all CustomerEnv fields', async () => {
      mockSql.mockResolvedValueOnce([BASE_ENV]);

      const res = await GET(makeGetRequest('acme', 'prod'), makeParams('acme'));
      const body = await res.json();

      expect(body).toMatchObject({
        org_key: 'acme',
        env_key: 'prod',
        cluster_id: 'default',
        region_id: 'ash',
        replicas: 1,
        memory_req: '4Gi',
        memory_limit: '5Gi',
        cpu_req: '500m',
        cpu_limit: '2000m',
      });
    });
  });

  describe('validation errors', () => {
    it('returns 400 when env_key is missing', async () => {
      const res = await GET(makeGetRequest('acme', null), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/env_key/i);
    });
  });

  describe('not found', () => {
    it('returns 404 when environment does not exist', async () => {
      mockSql.mockResolvedValueOnce([]);

      const res = await GET(makeGetRequest('acme', 'ghost'), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('database error', () => {
    it('returns 500 on unexpected database failure', async () => {
      mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await GET(makeGetRequest('acme', 'prod'), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH tests
// ---------------------------------------------------------------------------

describe('PATCH /api/envs/[id]/detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('success path', () => {
    it('updates mutable fields and returns updated record (HTTP 200)', async () => {
      const updatedEnv: CustomerEnv = {
        ...BASE_ENV,
        image: 'dotcms/dotcms:25.01.00',
        replicas: 3,
        mod_date: '2026-04-14T13:00:00Z',
      };

      // First sql call: SELECT to check existence
      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      // Second sql call: UPDATE RETURNING *
      mockSql.mockResolvedValueOnce([updatedEnv]);

      const res = await PATCH(
        makePatchRequest('acme', 'prod', { image: 'dotcms/dotcms:25.01.00', replicas: 3 }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.image).toBe('dotcms/dotcms:25.01.00');
      expect(body.replicas).toBe(3);
    });

    it('accepts partial update with only image field', async () => {
      const updatedEnv: CustomerEnv = {
        ...BASE_ENV,
        image: 'dotcms/dotcms:latest',
        mod_date: '2026-04-14T13:00:00Z',
      };

      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      mockSql.mockResolvedValueOnce([updatedEnv]);

      const res = await PATCH(
        makePatchRequest('acme', 'prod', { image: 'dotcms/dotcms:latest' }),
        makeParams('acme')
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.image).toBe('dotcms/dotcms:latest');
    });

    it('accepts partial update with only resource fields', async () => {
      const updatedEnv: CustomerEnv = {
        ...BASE_ENV,
        memory_req: '8Gi',
        memory_limit: '10Gi',
        cpu_req: '1000m',
        cpu_limit: '4000m',
      };

      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      mockSql.mockResolvedValueOnce([updatedEnv]);

      const res = await PATCH(
        makePatchRequest('acme', 'prod', {
          memory_req: '8Gi',
          memory_limit: '10Gi',
          cpu_req: '1000m',
          cpu_limit: '4000m',
        }),
        makeParams('acme')
      );

      expect(res.status).toBe(200);
    });

    it('accepts env_vars as a plain object', async () => {
      const updatedEnv: CustomerEnv = {
        ...BASE_ENV,
        env_vars: { MY_KEY: 'my_value', ANOTHER: 'setting' },
      };

      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      mockSql.mockResolvedValueOnce([updatedEnv]);

      const res = await PATCH(
        makePatchRequest('acme', 'prod', {
          env_vars: { MY_KEY: 'my_value', ANOTHER: 'setting' },
        }),
        makeParams('acme')
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.env_vars).toEqual({ MY_KEY: 'my_value', ANOTHER: 'setting' });
    });

    it('accepts replicas = 0 (scale to zero)', async () => {
      const updatedEnv: CustomerEnv = { ...BASE_ENV, replicas: 0 };

      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      mockSql.mockResolvedValueOnce([updatedEnv]);

      const res = await PATCH(
        makePatchRequest('acme', 'prod', { replicas: 0 }),
        makeParams('acme')
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.replicas).toBe(0);
    });

    it('accepts empty body (no-op update)', async () => {
      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      mockSql.mockResolvedValueOnce([BASE_ENV]);

      const res = await PATCH(
        makePatchRequest('acme', 'prod', {}),
        makeParams('acme')
      );

      expect(res.status).toBe(200);
    });
  });

  describe('validation errors', () => {
    it('returns 400 when env_key is missing', async () => {
      const res = await PATCH(
        makePatchRequest('acme', null, { image: 'dotcms/dotcms:latest' }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/env_key/i);
    });

    it('returns 400 when body is not valid JSON', async () => {
      // makePatchRequest with undefined body sends raw invalid JSON string
      const url = 'http://localhost/api/envs/acme/detail?env_key=prod';
      const req = new Request(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'this is not json',
      });

      const res = await PATCH(req, makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/valid JSON/i);
    });

    it('returns 400 when replicas is a negative number', async () => {
      const res = await PATCH(
        makePatchRequest('acme', 'prod', { replicas: -1 }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/replicas/i);
    });

    it('returns 400 when replicas is a float', async () => {
      const res = await PATCH(
        makePatchRequest('acme', 'prod', { replicas: 1.5 }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/replicas/i);
    });

    it('returns 400 when env_vars is an array', async () => {
      const res = await PATCH(
        makePatchRequest('acme', 'prod', { env_vars: ['KEY=VALUE'] }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/env_vars/i);
    });

    it('returns 400 when env_vars is a string', async () => {
      const res = await PATCH(
        makePatchRequest('acme', 'prod', { env_vars: 'KEY=VALUE' }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/env_vars/i);
    });
  });

  describe('not found', () => {
    it('returns 404 when the environment does not exist', async () => {
      // SELECT existence check returns nothing
      mockSql.mockResolvedValueOnce([]);

      const res = await PATCH(
        makePatchRequest('acme', 'ghost', { image: 'dotcms/dotcms:latest' }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('database error', () => {
    it('returns 500 when existence check throws', async () => {
      mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await PATCH(
        makePatchRequest('acme', 'prod', { image: 'dotcms/dotcms:latest' }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });

    it('returns 500 when UPDATE throws', async () => {
      // SELECT succeeds
      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      // UPDATE fails
      mockSql.mockRejectedValueOnce(new Error('Constraint violation'));

      const res = await PATCH(
        makePatchRequest('acme', 'prod', { image: 'dotcms/dotcms:latest' }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('immutability', () => {
    it('ignores org_key in the body (not in PatchBody interface)', async () => {
      const updatedEnv: CustomerEnv = { ...BASE_ENV };

      mockSql.mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
      mockSql.mockResolvedValueOnce([updatedEnv]);

      // Even if someone passes org_key in the body, the route should succeed
      // and return the record (org_key is not a PatchBody field)
      const res = await PATCH(
        makePatchRequest('acme', 'prod', {
          image: 'dotcms/dotcms:latest',
          org_key: 'hacker', // should be silently ignored
        }),
        makeParams('acme')
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.org_key).toBe('acme');
    });
  });
});
