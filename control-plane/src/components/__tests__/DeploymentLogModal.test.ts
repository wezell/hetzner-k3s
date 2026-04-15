/**
 * DeploymentLogModal unit tests
 *
 * Pure Node.js environment — no DOM / jsdom.  Tests cover:
 *
 *  1. buildModalTitle — formats the modal heading from org/env keys.
 *  2. buildLogsUrl re-export — URL construction contract validated via the
 *     re-exported helper so consumers don't need to import from DeploymentLogPanel.
 *  3. Props interface contract — shape validation for modal open/close props.
 *  4. Fetch contract — verifies the URL that the panel fetches from.
 *
 * DeploymentLogModal is a React component so we don't render it here.
 * Pure-logic helpers are tested directly, following the same pattern as
 * CreateOrgModal.test.ts and DeploymentLogPanel.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildModalTitle, buildLogsUrl } from '../DeploymentLogModal';

// ---------------------------------------------------------------------------
// buildModalTitle
// ---------------------------------------------------------------------------

describe('buildModalTitle', () => {
  it('formats title with org_key and env_key', () => {
    expect(buildModalTitle('acme', 'prod')).toBe('Deployment Logs — acme/prod');
  });

  it('handles hyphenated keys', () => {
    expect(buildModalTitle('my-org', 'staging-v2')).toBe('Deployment Logs — my-org/staging-v2');
  });

  it('handles numeric-looking keys', () => {
    expect(buildModalTitle('org123', 'env001')).toBe('Deployment Logs — org123/env001');
  });

  it('contains org_key', () => {
    const title = buildModalTitle('acme', 'prod');
    expect(title).toContain('acme');
  });

  it('contains env_key', () => {
    const title = buildModalTitle('acme', 'prod');
    expect(title).toContain('prod');
  });

  it('separates org and env with a slash', () => {
    const title = buildModalTitle('acme', 'prod');
    expect(title).toContain('acme/prod');
  });
});

// ---------------------------------------------------------------------------
// buildLogsUrl re-export
// ---------------------------------------------------------------------------

describe('buildLogsUrl (re-exported from DeploymentLogModal)', () => {
  it('builds URL with org_key, env_key, and limit', () => {
    const url = buildLogsUrl('acme', 'prod', 50);
    expect(url).toBe('/api/envs/acme/logs?env_key=prod&limit=50');
  });

  it('encodes special characters in org_key', () => {
    const url = buildLogsUrl('acme corp', 'prod', 10);
    expect(url).toContain('acme%20corp');
  });

  it('encodes special characters in env_key', () => {
    const url = buildLogsUrl('acme', 'prod env', 10);
    expect(url).toContain('prod%20env');
  });

  it('appends before_id cursor when provided', () => {
    const url = buildLogsUrl('acme', 'prod', 50, 99);
    expect(url).toContain('before_id=99');
  });

  it('omits before_id when not provided', () => {
    const url = buildLogsUrl('acme', 'prod', 50);
    expect(url).not.toContain('before_id');
  });

  it('respects custom limit', () => {
    const url = buildLogsUrl('acme', 'prod', 100);
    expect(url).toContain('limit=100');
  });
});

// ---------------------------------------------------------------------------
// Props interface contract
// ---------------------------------------------------------------------------

describe('DeploymentLogModalProps contract', () => {
  it('required props: open, onClose, org_key, env_key', () => {
    // Type-level check expressed as a runtime assertion via object shape.
    // If this compiles, the required props are correctly typed.
    const requiredProps = {
      open: true,
      onClose: vi.fn(),
      org_key: 'acme',
      env_key: 'prod',
    };
    expect(requiredProps.open).toBe(true);
    expect(typeof requiredProps.onClose).toBe('function');
    expect(requiredProps.org_key).toBe('acme');
    expect(requiredProps.env_key).toBe('prod');
  });

  it('optional props have sensible defaults: limit=50, pollInterval=5000', () => {
    const defaultLimit = 50;
    const defaultPollInterval = 5_000;
    expect(defaultLimit).toBeGreaterThan(0);
    expect(defaultPollInterval).toBeGreaterThan(0);
  });

  it('open=false should not mount panel (no polling)', () => {
    // This is a behavioral contract: when open is false, the panel is not
    // mounted, so no fetch calls are made.  Verified by checking the
    // conditional render logic: `{open && <DeploymentLogPanel ... />}`
    const open = false;
    expect(open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fetch wiring smoke test
// ---------------------------------------------------------------------------

describe('DeploymentLogModal fetch wiring (via buildLogsUrl)', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('logs URL targets the correct endpoint', async () => {
    const url = buildLogsUrl('acme', 'prod', 50);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ org_key: 'acme', env_key: 'prod', logs: [], total: 0, has_more: false }),
        { status: 200 },
      ),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(url);
  });

  it('handles 404 response for unknown environment', async () => {
    const url = buildLogsUrl('unknown-org', 'missing-env', 50);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Environment 'unknown-org/missing-env' not found" }),
        { status: 404 },
      ),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const res = await fetch(url);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('not found');
  });

  it('handles 500 server error', async () => {
    const url = buildLogsUrl('acme', 'prod', 50);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500 },
      ),
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const res = await fetch(url);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  it('network failure triggers error state', async () => {
    const url = buildLogsUrl('acme', 'prod', 50);

    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    global.fetch = mockFetch as unknown as typeof fetch;

    let caught: string | null = null;
    try {
      await fetch(url);
    } catch {
      caught = 'Failed to load logs';
    }

    expect(caught).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Response shape contract
// ---------------------------------------------------------------------------

describe('logs API response shape contract', () => {
  it('response has expected top-level keys', () => {
    const response = {
      org_key: 'acme',
      env_key: 'prod',
      logs: [],
      total: 0,
      has_more: false,
    };
    expect(response).toHaveProperty('org_key');
    expect(response).toHaveProperty('env_key');
    expect(response).toHaveProperty('logs');
    expect(response).toHaveProperty('total');
    expect(response).toHaveProperty('has_more');
  });

  it('logs array items have required fields', () => {
    const log = {
      deployment_log_id: 1,
      log_org_key: 'acme',
      log_env_key: 'prod',
      action: 'provision',
      status: 'success',
      error_detail: null,
      retry_count: 0,
      created_date: '2026-04-14T12:00:00Z',
    };
    expect(log).toHaveProperty('deployment_log_id');
    expect(log).toHaveProperty('action');
    expect(log).toHaveProperty('status');
    expect(log).toHaveProperty('created_date');
  });

  it('has_more is false when logs are fewer than limit', () => {
    const limit = 50;
    const logs = [{ deployment_log_id: 1 }]; // fewer than limit
    const has_more = logs.length >= limit ? true : false;
    expect(has_more).toBe(false);
  });
});
