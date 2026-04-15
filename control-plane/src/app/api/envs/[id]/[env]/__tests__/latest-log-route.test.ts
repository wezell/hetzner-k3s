/**
 * Tests: GET /api/envs/[id]/[env]/logs/latest endpoint
 *
 * Requirements:
 *   1. Returns the single most-recent deployment_log entry for a given environment
 *   2. Returns `log: null` when the environment has no log entries yet
 *   3. Returns 404 when the environment does not exist
 *   4. Returns 500 on database error
 *   5. Response always contains org_key, env_key, and log fields
 *
 * SQL call sequence:
 *   1. EXISTS check (customer_env)
 *   2. SELECT LIMIT 1 FROM deployment_log (newest first)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeploymentLog } from '@/db/types';

// ---------------------------------------------------------------------------
// Mock @/db using a queue-based approach
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
const { GET } = await import('../logs/latest/route');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog(overrides: Partial<DeploymentLog> = {}): DeploymentLog {
  return {
    deployment_log_id: 42,
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

function makeRequest(org: string, env: string): Request {
  const url = `http://localhost/api/envs/${org}/${env}/logs/latest`;
  return new Request(url, { method: 'GET' });
}

function makeParams(org: string, env: string) {
  return { params: Promise.resolve({ id: org, env }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSql._queue.length = 0;
});

// ---------------------------------------------------------------------------
// 1. Happy path: environment exists with log entries
// ---------------------------------------------------------------------------

describe('GET /api/envs/[id]/[env]/logs/latest — happy path', () => {
  it('returns HTTP 200 for a valid environment', async () => {
    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push([makeLog()]);

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    expect(res.status).toBe(200);
  });

  it('returns the most-recent log entry with all DeploymentLog fields', async () => {
    const log = makeLog({
      deployment_log_id: 99,
      action: 'patch',
      status: 'failed',
      error_detail: 'timeout waiting for pod',
      retry_count: 3,
      created_date: '2026-04-14T15:30:00.000Z',
    });

    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push([log]);

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.org_key).toBe('acme');
    expect(body.env_key).toBe('prod');
    expect(body.log).not.toBeNull();
    expect(body.log.deployment_log_id).toBe(99);
    expect(body.log.action).toBe('patch');
    expect(body.log.status).toBe('failed');
    expect(body.log.error_detail).toBe('timeout waiting for pod');
    expect(body.log.retry_count).toBe(3);
    expect(body.log.created_date).toBe('2026-04-14T15:30:00.000Z');
  });

  it('echoes org_key and env_key from path params', async () => {
    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push([makeLog({ log_org_key: 'myorg', log_env_key: 'staging' })]);

    const res = await GET(makeRequest('myorg', 'staging'), makeParams('myorg', 'staging'));
    const body = await res.json();

    expect(body.org_key).toBe('myorg');
    expect(body.env_key).toBe('staging');
  });
});

// ---------------------------------------------------------------------------
// 2. Environment exists but has no logs yet
// ---------------------------------------------------------------------------

describe('environment with no logs', () => {
  it('returns log: null when the environment has no log entries', async () => {
    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push([]); // empty result set

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.log).toBeNull();
  });

  it('still returns org_key and env_key when log is null', async () => {
    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push([]);

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    const body = await res.json();

    expect(body.org_key).toBe('acme');
    expect(body.env_key).toBe('prod');
    expect(body.log).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Not found
// ---------------------------------------------------------------------------

describe('not found', () => {
  it('returns 404 when the environment does not exist', async () => {
    mockSql._queue.push([{ exists: false }]);

    const res = await GET(makeRequest('acme', 'ghost'), makeParams('acme', 'ghost'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
    expect(body.error).toContain('acme/ghost');
  });

  it('returns 404 for unknown org', async () => {
    mockSql._queue.push([{ exists: false }]);

    const res = await GET(makeRequest('unknown-org', 'prod'), makeParams('unknown-org', 'prod'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Database error
// ---------------------------------------------------------------------------

describe('database error', () => {
  it('returns 500 on database failure during EXISTS check', async () => {
    mockSql._queue.push(new Error('DB connection lost'));

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal server error');
  });

  it('returns 500 on database failure during log fetch', async () => {
    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push(new Error('Query timeout'));

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal server error');
  });
});

// ---------------------------------------------------------------------------
// 5. Response shape contract
// ---------------------------------------------------------------------------

describe('response shape contract', () => {
  it('response always contains org_key, env_key, and log fields', async () => {
    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push([makeLog()]);

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    const body = await res.json();

    expect(body).toHaveProperty('org_key');
    expect(body).toHaveProperty('env_key');
    expect(body).toHaveProperty('log');
  });

  it('log field is either a DeploymentLog object or null — never undefined', async () => {
    mockSql._queue.push([{ exists: true }]);
    mockSql._queue.push([]);

    const res = await GET(makeRequest('acme', 'prod'), makeParams('acme', 'prod'));
    const body = await res.json();

    // JSON serializes undefined as absent, but null as null
    expect('log' in body).toBe(true);
    expect(body.log).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. URL contract
// ---------------------------------------------------------------------------

describe('URL contract', () => {
  it('endpoint URL follows /api/envs/:org/:env/logs/latest convention', () => {
    const org = 'acme';
    const env = 'prod';
    const url = `/api/envs/${encodeURIComponent(org)}/${encodeURIComponent(env)}/logs/latest`;
    expect(url).toBe('/api/envs/acme/prod/logs/latest');
  });

  it('URL encodes org and env keys for safety', () => {
    const org = 'my-org';
    const env = 'my-env';
    const url = `/api/envs/${encodeURIComponent(org)}/${encodeURIComponent(env)}/logs/latest`;
    expect(url).toBe('/api/envs/my-org/my-env/logs/latest');
  });
});
