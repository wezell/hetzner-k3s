/**
 * EnvList dual-field search verification
 *
 * Confirms that the environment list search filters correctly by both
 * org_id (org_key) and env_id (env_key / name) fields simultaneously,
 * matching all four combinations: both, org-only, env-only, and neither.
 *
 * Two test suites:
 *   1. buildEnvUrl — pure URL-building logic (no React, no DB)
 *   2. GET /api/envs — SQL branch selection for each filter combination
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Suite 1: buildEnvUrl URL-building logic
// ---------------------------------------------------------------------------
import { buildEnvUrl } from '@/lib/envSearch';

describe('buildEnvUrl — dual-field search URL building', () => {
  it('returns /api/envs with no params when both fields are empty', () => {
    expect(buildEnvUrl('', '')).toBe('/api/envs');
  });

  it('returns /api/envs with no params when both fields are whitespace-only', () => {
    expect(buildEnvUrl('   ', '   ')).toBe('/api/envs');
  });

  it('builds URL with org_key only when only orgSearch is provided', () => {
    expect(buildEnvUrl('acme', '')).toBe('/api/envs?org_key=acme');
  });

  it('builds URL with name only when only nameSearch is provided', () => {
    // URLSearchParams does not percent-encode * — it stays as a literal asterisk
    expect(buildEnvUrl('', 'prod*')).toBe('/api/envs?name=prod*');
  });

  it('builds URL with BOTH org_key AND name when both fields are provided', () => {
    const url = buildEnvUrl('acme', 'prod*');
    const parsed = new URL(url, 'http://localhost');
    // Both params must be present for simultaneous dual-field filtering
    expect(parsed.searchParams.get('org_key')).toBe('acme');
    expect(parsed.searchParams.get('name')).toBe('prod*');
  });

  it('combined URL has exactly two query params', () => {
    const url = buildEnvUrl('globalcorp', '*prod*');
    const parsed = new URL(url, 'http://localhost');
    expect([...parsed.searchParams.keys()]).toHaveLength(2);
    expect(parsed.searchParams.get('org_key')).toBe('globalcorp');
    expect(parsed.searchParams.get('name')).toBe('*prod*');
  });

  it('trims whitespace from both search fields before building URL', () => {
    const url = buildEnvUrl('  acme  ', '  *staging*  ');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('org_key')).toBe('acme');
    expect(parsed.searchParams.get('name')).toBe('*staging*');
  });

  it('handles org_key with hyphens correctly', () => {
    const url = buildEnvUrl('my-org-123', 'dev');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('org_key')).toBe('my-org-123');
    expect(parsed.searchParams.get('name')).toBe('dev');
  });

  it('handles wildcard-only env search (glob pattern)', () => {
    const url = buildEnvUrl('acme', '*');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('org_key')).toBe('acme');
    expect(parsed.searchParams.get('name')).toBe('*');
  });

  it('omits org_key when orgSearch is whitespace-only (env-only filtering)', () => {
    const url = buildEnvUrl('   ', 'prod');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.has('org_key')).toBe(false);
    expect(parsed.searchParams.get('name')).toBe('prod');
  });

  it('omits name when nameSearch is whitespace-only (org-only filtering)', () => {
    const url = buildEnvUrl('acme', '   ');
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('org_key')).toBe('acme');
    expect(parsed.searchParams.has('name')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: GET /api/envs — SQL branch selection for each filter combination
// ---------------------------------------------------------------------------

// vi.hoisted() ensures mockSql is available inside the vi.mock() factory,
// which is hoisted to top of file by Vitest's transform.
const { mockSql } = vi.hoisted(() => {
  const mockSql = vi.fn();
  return { mockSql };
});

vi.mock('@/db', () => ({
  sql: mockSql,
  default: mockSql,
}));

import { GET } from '@/app/api/envs/route';

describe('GET /api/envs — combined org_key + name filtering (SQL branch selection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
  });

  it('uses WHERE...AND clause when both org_key and name params are present', async () => {
    const req = new Request('http://localhost/api/envs?org_key=acme&name=prod*', {
      method: 'GET',
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(mockSql).toHaveBeenCalledOnce();
    const call = mockSql.mock.calls[0] as unknown[];
    const sqlStrings = (call[0] as string[]).join('').toLowerCase();

    // Must filter by org_key (exact match)
    expect(sqlStrings).toContain('where');
    expect(sqlStrings).toContain('org_key');
    // Must combine both filters with AND
    expect(sqlStrings).toContain('and');
    // Must filter by env_key using ILIKE (wildcard)
    expect(sqlStrings).toContain('ilike');
    expect(sqlStrings).toContain('env_key');
  });

  it('uses WHERE org_key without AND/ILIKE when only org_key is provided', async () => {
    const req = new Request('http://localhost/api/envs?org_key=acme', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockSql.mock.calls[0] as unknown[];
    const sqlStrings = (call[0] as string[]).join('').toLowerCase();
    expect(sqlStrings).toContain('where');
    expect(sqlStrings).toContain('org_key');
    // No env_key wildcard filter in single-param case
    expect(sqlStrings).not.toContain('ilike');
  });

  it('uses WHERE env_key ILIKE without org_key when only name is provided', async () => {
    const req = new Request('http://localhost/api/envs?name=prod*', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockSql.mock.calls[0] as unknown[];
    const sqlStrings = (call[0] as string[]).join('').toLowerCase();
    expect(sqlStrings).toContain('ilike');
    expect(sqlStrings).toContain('env_key');
    // Should not filter on org_key
    expect(sqlStrings).not.toContain('org_key =');
  });

  it('returns all envs with ORDER BY but no WHERE when neither param is provided', async () => {
    const req = new Request('http://localhost/api/envs', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockSql.mock.calls[0] as unknown[];
    const sqlStrings = (call[0] as string[]).join('').toLowerCase();
    // No filtering — just ORDER BY
    expect(sqlStrings).not.toContain('where');
    expect(sqlStrings).toContain('order by');
  });

  it('converts * wildcards to % for SQL ILIKE in combined filtering mode', async () => {
    const req = new Request('http://localhost/api/envs?org_key=acme&name=*staging*', {
      method: 'GET',
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockSql.mock.calls[0] as unknown[];
    // The interpolated values are the non-string args in the tagged-template call
    const interpolatedValues = call.slice(1);
    const namePattern = interpolatedValues.find(
      (v) => typeof v === 'string' && v.includes('%')
    );
    // * must be converted to % for SQL ILIKE
    expect(namePattern).toBe('%staging%');
  });

  it('converts * wildcards to % for SQL ILIKE in name-only filtering mode', async () => {
    const req = new Request('http://localhost/api/envs?name=dev*', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockSql.mock.calls[0] as unknown[];
    const interpolatedValues = call.slice(1);
    const namePattern = interpolatedValues.find(
      (v) => typeof v === 'string' && v.includes('%')
    );
    expect(namePattern).toBe('dev%');
  });

  it('returns 200 with empty array when no envs match combined filter', async () => {
    mockSql.mockResolvedValue([]);
    const req = new Request('http://localhost/api/envs?org_key=nobody&name=nothing', {
      method: 'GET',
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toEqual([]);
  });
});
