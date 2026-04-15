/**
 * Tests: POST /api/envs/[id]/retrigger endpoint
 *
 * AC 90101 requirements:
 *   1. POST accepts action body param (provision|patch|stop|decommission)
 *   2. Resets deploy_status to the appropriate pending/queued state
 *   3. Writes a synthetic 'success' log to reset the retry window
 *   4. Returns 200 with org_key, env_key, action, queued_status, and message
 *   5. Returns 400 when env_key is missing
 *   6. Returns 400 when action is missing or invalid
 *   7. Returns 400 when body is not valid JSON
 *   8. Returns 404 when environment not found
 *   9. Returns 409 when environment is decommissioned (terminal)
 *  10. Returns 500 on database error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { POST } from '../[id]/retrigger/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  orgKey: string,
  envKey: string | null,
  body?: Record<string, unknown>,
  rawBody?: string,
): Request {
  const url = envKey
    ? `http://localhost/api/envs/${orgKey}/retrigger?env_key=${envKey}`
    : `http://localhost/api/envs/${orgKey}/retrigger`;

  const bodyStr = rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);

  return new Request(url, {
    method: 'POST',
    headers: bodyStr ? { 'Content-Type': 'application/json' } : {},
    body: bodyStr,
  });
}

function makeParams(orgKey: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: orgKey }) };
}

/**
 * Enqueue mock responses for sequential sql() calls:
 *   call 0: SELECT (env lookup) → returns [envRow] or []
 *   call 1: INSERT deployment_log (retry reset) → returns []
 *   call 2: UPDATE deploy_status → returns []
 */
function enqueueResponses(...responses: unknown[]): void {
  for (const res of responses) {
    mockSql.mockResolvedValueOnce(res);
  }
}

const BASE_ENV_ROW = {
  org_key: 'acme',
  env_key: 'prod',
  deploy_status: 'failed',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/envs/[id]/retrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Success paths — one per action type
  // -------------------------------------------------------------------------

  describe('success: action=provision', () => {
    it('returns 200 with queued_status=pending', async () => {
      enqueueResponses(
        [BASE_ENV_ROW],  // SELECT
        [],              // INSERT deployment_log
        [],              // UPDATE customer_env
      );

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'provision' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.org_key).toBe('acme');
      expect(body.env_key).toBe('prod');
      expect(body.action).toBe('provision');
      expect(body.queued_status).toBe('pending');
      expect(body.message).toMatch(/pending/);
    });

    it('calls sql 3 times: SELECT → INSERT log → UPDATE status', async () => {
      enqueueResponses([BASE_ENV_ROW], [], []);

      await POST(makeRequest('acme', 'prod', { action: 'provision' }), makeParams('acme'));

      expect(mockSql).toHaveBeenCalledTimes(3);
    });
  });

  describe('success: action=patch', () => {
    it('returns 200 with queued_status=reconfiguring', async () => {
      enqueueResponses(
        [{ ...BASE_ENV_ROW, deploy_status: 'failed' }],
        [],
        [],
      );

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'patch' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.action).toBe('patch');
      expect(body.queued_status).toBe('reconfiguring');
    });
  });

  describe('success: action=stop', () => {
    it('returns 200 with queued_status=stopping', async () => {
      enqueueResponses(
        [{ ...BASE_ENV_ROW, deploy_status: 'deployed' }],
        [],
        [],
      );

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'stop' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.action).toBe('stop');
      expect(body.queued_status).toBe('stopping');
    });
  });

  describe('success: action=decommission', () => {
    it('returns 200 with queued_status=decommissioning', async () => {
      enqueueResponses(
        [{ ...BASE_ENV_ROW, deploy_status: 'stopped' }],
        [],
        [],
      );

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'decommission' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.action).toBe('decommission');
      expect(body.queued_status).toBe('decommissioning');
    });
  });

  // -------------------------------------------------------------------------
  // Retry-reset: all action types write the synthetic success log
  // -------------------------------------------------------------------------

  describe('retry window reset', () => {
    it.each(['provision', 'patch', 'stop', 'decommission'] as const)(
      'writes a synthetic success log entry for action=%s',
      async (action) => {
        enqueueResponses([BASE_ENV_ROW], [], []);

        await POST(makeRequest('acme', 'prod', { action }), makeParams('acme'));

        // Second call (index 1) is the INSERT into deployment_log
        const logInsertCall = mockSql.mock.calls[1];
        // The template literal tag call passes the strings array as the first arg
        // and interpolated values follow. We verify 'success' appears in the values.
        const callArgs = logInsertCall.flat(Infinity) as string[];
        const callStr = callArgs.join(' ');
        expect(callStr).toMatch(/success/);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------

  describe('validation errors', () => {
    it('returns 400 when env_key query param is missing', async () => {
      const res = await POST(
        makeRequest('acme', null, { action: 'provision' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/env_key/i);
    });

    it('returns 400 when action is missing from body', async () => {
      const res = await POST(makeRequest('acme', 'prod', {}), makeParams('acme'));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/action/i);
    });

    it('returns 400 when action is invalid', async () => {
      const res = await POST(
        makeRequest('acme', 'prod', { action: 'invalid-action' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/action/i);
    });

    it('returns 400 when body is not valid JSON', async () => {
      const res = await POST(
        makeRequest('acme', 'prod', undefined, 'not-json{{{'),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/json/i);
    });

    it.each(['provision', 'patch', 'stop', 'decommission'] as const)(
      'accepts valid action=%s without validation error',
      async (action) => {
        enqueueResponses([BASE_ENV_ROW], [], []);

        const res = await POST(
          makeRequest('acme', 'prod', { action }),
          makeParams('acme'),
        );

        expect(res.status).toBe(200);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------

  describe('not found', () => {
    it('returns 404 when environment does not exist', async () => {
      enqueueResponses([]); // SELECT returns nothing

      const res = await POST(
        makeRequest('acme', 'ghost', { action: 'provision' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });

    it('only calls sql once when env is not found (no INSERT/UPDATE)', async () => {
      enqueueResponses([]);

      await POST(makeRequest('acme', 'ghost', { action: 'provision' }), makeParams('acme'));

      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Conflict: decommissioned is terminal
  // -------------------------------------------------------------------------

  describe('conflict: decommissioned environment', () => {
    it('returns 409 when environment is already decommissioned', async () => {
      enqueueResponses([{ ...BASE_ENV_ROW, deploy_status: 'decommissioned' }]);

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'provision' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error).toMatch(/decommissioned/i);
    });

    it('does not write log or update status for decommissioned env (only 1 DB call)', async () => {
      enqueueResponses([{ ...BASE_ENV_ROW, deploy_status: 'decommissioned' }]);

      await POST(
        makeRequest('acme', 'prod', { action: 'provision' }),
        makeParams('acme'),
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it.each(['patch', 'stop', 'decommission'] as const)(
      'returns 409 for decommissioned env even with action=%s',
      async (action) => {
        enqueueResponses([{ ...BASE_ENV_ROW, deploy_status: 'decommissioned' }]);

        const res = await POST(makeRequest('acme', 'prod', { action }), makeParams('acme'));

        expect(res.status).toBe(409);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Database error
  // -------------------------------------------------------------------------

  describe('database error', () => {
    it('returns 500 on unexpected database failure during SELECT', async () => {
      mockSql.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'provision' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });

    it('returns 500 on failure during INSERT log', async () => {
      enqueueResponses([BASE_ENV_ROW]); // SELECT succeeds
      mockSql.mockRejectedValueOnce(new Error('INSERT failed'));

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'provision' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });

  // -------------------------------------------------------------------------
  // Response shape contract
  // -------------------------------------------------------------------------

  describe('response shape', () => {
    it('returns org_key, env_key, action, queued_status, and message', async () => {
      enqueueResponses([BASE_ENV_ROW], [], []);

      const res = await POST(
        makeRequest('acme', 'prod', { action: 'provision' }),
        makeParams('acme'),
      );
      const body = await res.json();

      expect(body).toMatchObject({
        org_key: 'acme',
        env_key: 'prod',
        action: 'provision',
        queued_status: 'pending',
        message: expect.stringContaining('pending'),
      });
    });

    it.each([
      ['provision', 'pending'],
      ['patch', 'reconfiguring'],
      ['stop', 'stopping'],
      ['decommission', 'decommissioning'],
    ] as const)(
      'action=%s maps to queued_status=%s',
      async (action, expectedStatus) => {
        enqueueResponses([BASE_ENV_ROW], [], []);

        const res = await POST(
          makeRequest('acme', 'prod', { action }),
          makeParams('acme'),
        );
        const body = await res.json();

        expect(body.queued_status).toBe(expectedStatus);
      },
    );
  });
});
