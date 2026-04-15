/**
 * Tests: GET /api/envs/[id]/logs endpoint
 *
 * AC 80202 requirements:
 *   1. Returns deployment_log entries sorted by created_date DESC, deployment_log_id DESC
 *   2. Supports `env_key` required query param
 *   3. Supports `limit` optional param (default 50, max 500)
 *   4. Supports `before_id` cursor for keyset pagination
 *   5. Supports `action` filter (provision|patch|stop|decommission)
 *   6. Supports `status` filter (success|failed|retrying)
 *   7. Returns `total` count and `has_more` flag for pagination
 *   8. Returns 400 for missing/invalid params
 *   9. Returns 404 when env not found
 *  10. Returns 500 on database error
 *
 * SQL call sequence (no fragment calls — uses nullable params instead):
 *   1. EXISTS check (customer_env)
 *   2. SELECT logs FROM deployment_log
 *   3. SELECT COUNT(*) FROM deployment_log
 *   4. has_more EXISTS (only when logs.length === limit)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeploymentLog } from '@/db/types';

// ---------------------------------------------------------------------------
// Mock @/db using a queue-based approach (same pattern as status-route.test.ts)
// ---------------------------------------------------------------------------

const mockSql = vi.hoisted(() => {
  const queue: Array<unknown[] | Error> = [];

  const fn = Object.assign(
    (..._args: unknown[]) => {
      const result = queue.shift() ?? [];
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    },
    { _queue: queue }
  );

  return fn;
});

vi.mock('@/db', () => ({ sql: mockSql, default: mockSql }));

// Import AFTER mocks are registered
const { GET } = await import('../[id]/logs/route');

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

/** Enqueue responses for a standard successful request (no has_more check). */
function enqueue(envFound: boolean, logs: DeploymentLog[], total: number) {
  mockSql._queue.push([{ exists: envFound }]);  // EXISTS check
  mockSql._queue.push(logs);                     // SELECT logs
  mockSql._queue.push([{ total: String(total) }]); // COUNT(*)
}

/** Enqueue responses including the has_more EXISTS check. */
function enqueueWithMore(
  envFound: boolean,
  logs: DeploymentLog[],
  total: number,
  hasMore: boolean
) {
  enqueue(envFound, logs, total);
  mockSql._queue.push([{ exists: hasMore }]); // has_more EXISTS
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLog(overrides: Partial<DeploymentLog> = {}): DeploymentLog {
  return {
    deployment_log_id: 1,
    log_org_key: 'acme',
    log_env_key: 'prod',
    action: 'provision',
    status: 'success',
    error_detail: null,
    retry_count: 0,
    created_date: '2026-04-14T12:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(orgKey: string, qs: Record<string, string | number | undefined>): Request {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const url = `http://localhost/api/envs/${orgKey}/logs?${params.toString()}`;
  return new Request(url, { method: 'GET' });
}

function makeParams(orgKey: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: orgKey }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSql._queue.length = 0;
});

// ---------------------------------------------------------------------------
// 1. Happy path: basic request
// ---------------------------------------------------------------------------

describe('GET /api/envs/[id]/logs — happy path', () => {
  it('returns HTTP 200 for a valid env', async () => {
    enqueue(true, [], 0);
    const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
    expect(res.status).toBe(200);
  });

  it('returns logs array with total and has_more for a valid env', async () => {
    const logs: DeploymentLog[] = [
      makeLog({ deployment_log_id: 10, created_date: '2026-04-14T12:00:00.000Z' }),
      makeLog({ deployment_log_id: 9, created_date: '2026-04-14T11:00:00.000Z' }),
    ];

    enqueue(true, logs, 2);

    const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.org_key).toBe('acme');
    expect(body.env_key).toBe('prod');
    expect(body.logs).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.has_more).toBe(false);
  });

  it('returns logs sorted newest-first (as returned by the query)', async () => {
    const logs: DeploymentLog[] = [
      makeLog({ deployment_log_id: 20, created_date: '2026-04-14T13:00:00.000Z', status: 'success' }),
      makeLog({ deployment_log_id: 18, created_date: '2026-04-14T12:00:00.000Z', status: 'retrying' }),
      makeLog({ deployment_log_id: 15, created_date: '2026-04-14T11:00:00.000Z', status: 'retrying' }),
    ];

    enqueue(true, logs, 3);

    const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
    const body = await res.json();

    expect(body.logs[0].deployment_log_id).toBe(20);
    expect(body.logs[1].deployment_log_id).toBe(18);
    expect(body.logs[2].deployment_log_id).toBe(15);
  });

  it('returns empty logs array when no entries exist', async () => {
    enqueue(true, [], 0);

    const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.logs).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.has_more).toBe(false);
  });

  it('returns all DeploymentLog fields in each log entry', async () => {
    const log = makeLog({
      deployment_log_id: 5,
      action: 'provision',
      status: 'failed',
      error_detail: 'pod not ready',
      retry_count: 2,
      created_date: '2026-04-14T10:00:00.000Z',
    });

    enqueue(true, [log], 1);

    const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
    const body = await res.json();
    const entry = body.logs[0];

    expect(entry.deployment_log_id).toBe(5);
    expect(entry.log_org_key).toBe('acme');
    expect(entry.log_env_key).toBe('prod');
    expect(entry.action).toBe('provision');
    expect(entry.status).toBe('failed');
    expect(entry.error_detail).toBe('pod not ready');
    expect(entry.retry_count).toBe(2);
    expect(entry.created_date).toBe('2026-04-14T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 2. Limit parameter
// ---------------------------------------------------------------------------

describe('limit parameter', () => {
  it('returns full page when logs.length < limit (has_more=false)', async () => {
    const logs = [makeLog({ deployment_log_id: 5 }), makeLog({ deployment_log_id: 4 })];
    enqueue(true, logs, 2);

    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 10 }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.has_more).toBe(false);
  });

  it('triggers has_more check when logs.length === limit', async () => {
    // Exactly 3 logs for limit=3 → triggers has_more check
    const logs = [
      makeLog({ deployment_log_id: 30 }),
      makeLog({ deployment_log_id: 29 }),
      makeLog({ deployment_log_id: 28 }),
    ];

    enqueueWithMore(true, logs, 10, true);

    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 3 }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.logs).toHaveLength(3);
    expect(body.has_more).toBe(true);
    expect(body.total).toBe(10);
  });

  it('returns 400 when limit is 0', async () => {
    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 0 }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/limit/i);
  });

  it('returns 400 when limit exceeds 500', async () => {
    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 501 }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/limit/i);
  });

  it('returns 400 when limit is not a number', async () => {
    const res = await GET(
      makeRequest('acme', { env_key: 'prod', limit: 'abc' as unknown as number }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/limit/i);
  });

  it('accepts limit=1 (minimum valid)', async () => {
    enqueue(true, [makeLog()], 1);
    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 1 }), makeParams('acme'));
    expect(res.status).toBe(200);
  });

  it('accepts limit=500 (maximum valid)', async () => {
    enqueue(true, [], 0);
    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 500 }), makeParams('acme'));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. Pagination with before_id cursor
// ---------------------------------------------------------------------------

describe('before_id cursor pagination', () => {
  it('sets has_more=true when more entries exist beyond the page', async () => {
    const logs = [
      makeLog({ deployment_log_id: 30 }),
      makeLog({ deployment_log_id: 29 }),
      makeLog({ deployment_log_id: 28 }),
    ];

    enqueueWithMore(true, logs, 30, true);

    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 3, before_id: 31 }), makeParams('acme'));
    const body = await res.json();

    expect(body.has_more).toBe(true);
    expect(body.total).toBe(30);
    expect(body.logs).toHaveLength(3);
  });

  it('sets has_more=false when the page exactly exhausts remaining entries', async () => {
    const logs = [
      makeLog({ deployment_log_id: 3 }),
      makeLog({ deployment_log_id: 2 }),
      makeLog({ deployment_log_id: 1 }),
    ];

    enqueueWithMore(true, logs, 3, false);

    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 3 }), makeParams('acme'));
    const body = await res.json();

    expect(body.has_more).toBe(false);
  });

  it('accepts valid before_id for page 2', async () => {
    const page2Logs = [
      makeLog({ deployment_log_id: 20 }),
      makeLog({ deployment_log_id: 15 }),
    ];

    enqueue(true, page2Logs, 25);

    const res = await GET(
      makeRequest('acme', { env_key: 'prod', limit: 10, before_id: 25 }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.logs).toHaveLength(2);
  });

  it('returns 400 when before_id is 0', async () => {
    const res = await GET(
      makeRequest('acme', { env_key: 'prod', before_id: 0 }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/before_id/i);
  });

  it('returns 400 when before_id is not a number', async () => {
    const res = await GET(
      makeRequest('acme', { env_key: 'prod', before_id: 'abc' as unknown as number }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/before_id/i);
  });

  it('returns 400 when before_id is negative', async () => {
    const res = await GET(
      makeRequest('acme', { env_key: 'prod', before_id: -5 }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/before_id/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Action filter
// ---------------------------------------------------------------------------

describe('action filter', () => {
  const validActions = ['provision', 'patch', 'stop', 'decommission'] as const;

  for (const action of validActions) {
    it(`accepts action=${action}`, async () => {
      const logs = [makeLog({ action, deployment_log_id: 5 })];
      enqueue(true, logs, 1);

      const res = await GET(
        makeRequest('acme', { env_key: 'prod', action }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.logs[0].action).toBe(action);
    });
  }

  it('returns 400 for an invalid action value', async () => {
    const res = await GET(
      makeRequest('acme', { env_key: 'prod', action: 'delete' }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/action/i);
    expect(body.error).toContain('provision');
  });
});

// ---------------------------------------------------------------------------
// 5. Status filter
// ---------------------------------------------------------------------------

describe('status filter', () => {
  const validStatuses = ['success', 'failed', 'retrying'] as const;

  for (const status of validStatuses) {
    it(`accepts status=${status}`, async () => {
      const logs = [makeLog({ status, deployment_log_id: 7 })];
      enqueue(true, logs, 1);

      const res = await GET(
        makeRequest('acme', { env_key: 'prod', status }),
        makeParams('acme')
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.logs[0].status).toBe(status);
    });
  }

  it('returns 400 for an invalid status value', async () => {
    const res = await GET(
      makeRequest('acme', { env_key: 'prod', status: 'pending' }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/status/i);
    expect(body.error).toContain('success');
  });

  it('returns 400 for status=deploying (not a valid LogStatus)', async () => {
    const res = await GET(
      makeRequest('acme', { env_key: 'prod', status: 'deploying' }),
      makeParams('acme')
    );
    const body = await res.json();

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 6. Validation errors
// ---------------------------------------------------------------------------

describe('validation errors', () => {
  it('returns 400 when env_key is missing', async () => {
    const res = await GET(makeRequest('acme', {}), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/env_key/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Not found
// ---------------------------------------------------------------------------

describe('not found', () => {
  it('returns 404 when the environment does not exist', async () => {
    mockSql._queue.push([{ exists: false }]);

    const res = await GET(makeRequest('acme', { env_key: 'ghost' }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
    expect(body.error).toContain('acme/ghost');
  });

  it('returns 404 for an org_key that has no environments', async () => {
    mockSql._queue.push([{ exists: false }]);

    const res = await GET(makeRequest('unknown-org', { env_key: 'prod' }), makeParams('unknown-org'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// 8. Database error
// ---------------------------------------------------------------------------

describe('database error', () => {
  it('returns 500 on unexpected database failure during EXISTS check', async () => {
    // Push an Error instance — the queue-based mock returns Promise.reject for Errors
    mockSql._queue.push(new Error('DB connection lost'));

    const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal server error');
  });
});

// ---------------------------------------------------------------------------
// 9. Response shape contract
// ---------------------------------------------------------------------------

describe('response shape contract', () => {
  it('response always contains org_key, env_key, logs, total, has_more', async () => {
    enqueue(true, [], 0);

    const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
    const body = await res.json();

    expect(body).toHaveProperty('org_key');
    expect(body).toHaveProperty('env_key');
    expect(body).toHaveProperty('logs');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('has_more');
    expect(Array.isArray(body.logs)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
  });

  it('org_key and env_key in response match the request params', async () => {
    enqueue(true, [], 0);

    const res = await GET(makeRequest('myorg', { env_key: 'staging' }), makeParams('myorg'));
    const body = await res.json();

    expect(body.org_key).toBe('myorg');
    expect(body.env_key).toBe('staging');
  });

  it('total reflects the full count independent of page size', async () => {
    const logs = Array.from({ length: 5 }, (_, i) =>
      makeLog({ deployment_log_id: 100 - i })
    );

    enqueueWithMore(true, logs, 100, true);

    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 5 }), makeParams('acme'));
    const body = await res.json();

    expect(body.total).toBe(100);
    expect(body.logs).toHaveLength(5);
    expect(body.has_more).toBe(true);
  });

  it('has_more is false when logs count < limit even if total > limit', async () => {
    const logs = [makeLog({ deployment_log_id: 1 })];
    enqueue(true, logs, 1);

    const res = await GET(makeRequest('acme', { env_key: 'prod', limit: 10 }), makeParams('acme'));
    const body = await res.json();

    expect(body.has_more).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. DeploymentLogPanel / URL contract
// ---------------------------------------------------------------------------

describe('URL contract', () => {
  it('endpoint URL constructed from org_key + env_key matches route convention', () => {
    const org_key = 'acme';
    const env_key = 'prod';
    const limit = 50;
    const url = `/api/envs/${encodeURIComponent(org_key)}/logs?env_key=${encodeURIComponent(env_key)}&limit=${limit}`;
    expect(url).toBe('/api/envs/acme/logs?env_key=prod&limit=50');
  });

  it('before_id cursor appended for page 2', () => {
    const org_key = 'acme';
    const env_key = 'prod';
    const limit = 50;
    const before_id = 99;
    const url = `/api/envs/${encodeURIComponent(org_key)}/logs?env_key=${encodeURIComponent(env_key)}&limit=${limit}&before_id=${before_id}`;
    expect(url).toBe('/api/envs/acme/logs?env_key=prod&limit=50&before_id=99');
  });

  it('action and status filters append to URL correctly', () => {
    const org_key = 'acme';
    const env_key = 'prod';
    const url = `/api/envs/${encodeURIComponent(org_key)}/logs?env_key=${encodeURIComponent(env_key)}&action=provision&status=failed`;
    expect(url).toBe('/api/envs/acme/logs?env_key=prod&action=provision&status=failed');
  });
});
