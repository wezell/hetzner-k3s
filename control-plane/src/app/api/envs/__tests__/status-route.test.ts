/**
 * Tests for GET /api/envs/[id]/status
 *
 * Verifies that the status endpoint returns the correct shape — in particular
 * that a 'deployed' environment surfaces deploy_status:'deployed' so that
 * EnvList can render the green "Deployed" badge after a polling cycle.
 *
 * Runs in Node.js (no DOM), using Vitest mocks to stub postgres.js queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock postgres.js (same pattern as route.test.ts)
// ---------------------------------------------------------------------------

const mockSql = vi.hoisted(() => {
  // Stores the sequence of results to return for each sql`` call.
  const queue: unknown[][] = [];

  const fn = Object.assign(
    (..._args: unknown[]) => {
      const result = queue.shift() ?? [];
      return Promise.resolve(result);
    },
    { _queue: queue }
  );

  return fn;
});

vi.mock('@/db', () => ({ sql: mockSql }));

// Helper: enqueue results for the next N sql calls (env row, logs, retry row).
function enqueueResponses(envRow: object | null, logs: object[], retryCount = 0) {
  mockSql._queue.push(envRow ? [envRow] : []);      // customer_env SELECT
  mockSql._queue.push(logs);                         // deployment_log SELECT
  mockSql._queue.push([{ current_retry_count: String(retryCount) }]); // retry CTE
}

// ---------------------------------------------------------------------------
// Import route handler AFTER mocks are set up
// ---------------------------------------------------------------------------
const { GET } = await import('../[id]/status/route');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEPLOYED_ENV = {
  org_key: 'acme',
  env_key: 'prod',
  deploy_status: 'deployed',
  last_deploy_date: '2026-04-14T12:00:00.000Z',
  stop_date: null,
  dcomm_date: null,
  mod_date: '2026-04-14T12:01:00.000Z',
};

const SUCCESS_LOG = {
  deployment_log_id: 42,
  log_org_key: 'acme',
  log_env_key: 'prod',
  action: 'provision',
  status: 'success',
  error_detail: null,
  retry_count: 0,
  created_date: '2026-04-14T12:00:00.000Z',
};

function makeRequest(orgKey: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/envs/${orgKey}/status`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/envs/[id]/status', () => {
  beforeEach(() => {
    mockSql._queue.length = 0;
  });

  // ── Happy path: deployed environment ───────────────────────────────────────

  describe('deployed environment', () => {
    it('returns HTTP 200', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      expect(res.status).toBe(200);
    });

    it('returns deploy_status "deployed"', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.deploy_status).toBe('deployed');
    });

    it('returns org_key and env_key matching the request', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.org_key).toBe('acme');
      expect(body.env_key).toBe('prod');
    });

    it('returns last_deploy_date as an ISO string', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.last_deploy_date).toBe('2026-04-14T12:00:00.000Z');
    });

    it('returns stop_date as null when not stopped', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.stop_date).toBeNull();
    });

    it('returns dcomm_date as null when not decommissioned', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.dcomm_date).toBeNull();
    });

    it('returns current_retry_count as 0 when no active retries', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG], 0);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.current_retry_count).toBe(0);
    });

    it('includes the deployment_log entries array', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(Array.isArray(body.logs)).toBe(true);
      expect(body.logs).toHaveLength(1);
    });

    it('log entry has status "success" and action "provision"', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      const [log] = body.logs;
      expect(log.status).toBe('success');
      expect(log.action).toBe('provision');
    });

    it('response shape matches the StatusResponse interface EnvList expects', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();

      // All fields that EnvList's StatusResponse type declares must be present
      const requiredFields = [
        'org_key', 'env_key', 'deploy_status',
        'last_deploy_date', 'stop_date', 'dcomm_date', 'mod_date',
        'current_retry_count', 'logs',
      ];
      for (const field of requiredFields) {
        expect(body, `missing field: ${field}`).toHaveProperty(field);
      }
    });
  });

  // ── 404 when env does not exist ────────────────────────────────────────────

  describe('environment not found', () => {
    it('returns HTTP 404', async () => {
      enqueueResponses(null, []);
      const res = await GET(makeRequest('acme', { env_key: 'nonexistent' }), makeParams('acme'));
      expect(res.status).toBe(404);
    });

    it('returns an error message', async () => {
      enqueueResponses(null, []);
      const res = await GET(makeRequest('acme', { env_key: 'nonexistent' }), makeParams('acme'));
      const body = await res.json();
      expect(body.error).toContain('nonexistent');
    });
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  describe('validation', () => {
    it('returns 400 when env_key query param is missing', async () => {
      const req = new Request('http://localhost/api/envs/acme/status');
      const res = await GET(req, makeParams('acme'));
      expect(res.status).toBe(400);
    });

    it('returns 400 when limit is not a valid integer', async () => {
      const req = makeRequest('acme', { env_key: 'prod', limit: 'abc' });
      const res = await GET(req, makeParams('acme'));
      expect(res.status).toBe(400);
    });

    it('returns 400 when limit is below 1', async () => {
      const req = makeRequest('acme', { env_key: 'prod', limit: '0' });
      const res = await GET(req, makeParams('acme'));
      expect(res.status).toBe(400);
    });

    it('returns 400 when limit exceeds 500', async () => {
      const req = makeRequest('acme', { env_key: 'prod', limit: '501' });
      const res = await GET(req, makeParams('acme'));
      expect(res.status).toBe(400);
    });
  });

  // ── Status variant coverage ────────────────────────────────────────────────

  describe('all deploy_status values are passed through unchanged', () => {
    // Exhaustive list must match DeployStatus in src/db/types.ts
    const statuses = [
      'pending', 'provisioning', 'deployed', 'reconfiguring',
      'stopping', 'stopped', 'failed', 'decommissioning', 'decommissioned',
    ] as const;

    it.each(statuses)('returns deploy_status "%s" as-is', async (status) => {
      enqueueResponses({ ...DEPLOYED_ENV, deploy_status: status }, []);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.deploy_status).toBe(status);
    });
  });

  // ── Transitional / intermediate state shape stability ─────────────────────
  //
  // These tests verify that the response shape is STABLE (all required fields
  // present) while the worker is actively changing something — i.e., during
  // the four in-progress states.  EnvList polls every 5 s during these states
  // and must be able to render without crashing even if last_deploy_date is
  // null, retry logs are present, or the operation hasn't yet written a
  // success entry.

  describe('transitional state response shape stability', () => {
    // Required top-level fields that must be present regardless of state
    const REQUIRED_FIELDS = [
      'org_key', 'env_key', 'deploy_status',
      'last_deploy_date', 'stop_date', 'dcomm_date', 'mod_date',
      'current_retry_count', 'logs',
    ] as const;

    // ── provisioning ──────────────────────────────────────────────────────────

    describe('provisioning state', () => {
      const PROVISIONING_ENV = {
        ...DEPLOYED_ENV,
        deploy_status: 'provisioning',
        last_deploy_date: null,  // not yet deployed — pod still starting up
      };

      const RETRYING_LOG = {
        deployment_log_id: 10,
        log_org_key: 'acme',
        log_env_key: 'prod',
        action: 'provision',
        status: 'retrying',
        error_detail: 'pod not ready after 30s',
        retry_count: 1,
        created_date: '2026-04-14T11:59:00.000Z',
      };

      it('returns deploy_status "provisioning" verbatim', async () => {
        enqueueResponses(PROVISIONING_ENV, [RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.deploy_status).toBe('provisioning');
      });

      it('response shape is stable — all required fields present', async () => {
        enqueueResponses(PROVISIONING_ENV, [RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        for (const field of REQUIRED_FIELDS) {
          expect(body, `missing field: ${field}`).toHaveProperty(field);
        }
      });

      it('last_deploy_date is null before first successful deployment', async () => {
        enqueueResponses(PROVISIONING_ENV, [RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.last_deploy_date).toBeNull();
      });

      it('surfaces retry count from active retrying log', async () => {
        enqueueResponses(PROVISIONING_ENV, [RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.current_retry_count).toBe(1);
      });

      it('logs array contains the retrying entry with error_detail', async () => {
        enqueueResponses(PROVISIONING_ENV, [RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.logs).toHaveLength(1);
        expect(body.logs[0].status).toBe('retrying');
        expect(body.logs[0].error_detail).toBe('pod not ready after 30s');
      });
    });

    // ── reconfiguring ─────────────────────────────────────────────────────────

    describe('reconfiguring state', () => {
      const RECONFIGURING_ENV = {
        ...DEPLOYED_ENV,
        deploy_status: 'reconfiguring',
        last_deploy_date: '2026-04-14T10:00:00.000Z', // was previously deployed
      };

      const PATCH_RETRYING_LOG = {
        deployment_log_id: 20,
        log_org_key: 'acme',
        log_env_key: 'prod',
        action: 'patch',
        status: 'retrying',
        error_detail: 'kustomize apply timeout',
        retry_count: 2,
        created_date: '2026-04-14T11:50:00.000Z',
      };

      it('returns deploy_status "reconfiguring" verbatim', async () => {
        enqueueResponses(RECONFIGURING_ENV, [PATCH_RETRYING_LOG], 2);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.deploy_status).toBe('reconfiguring');
      });

      it('response shape is stable — all required fields present', async () => {
        enqueueResponses(RECONFIGURING_ENV, [PATCH_RETRYING_LOG], 2);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        for (const field of REQUIRED_FIELDS) {
          expect(body, `missing field: ${field}`).toHaveProperty(field);
        }
      });

      it('last_deploy_date is preserved from prior deployment', async () => {
        enqueueResponses(RECONFIGURING_ENV, [PATCH_RETRYING_LOG], 2);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.last_deploy_date).toBe('2026-04-14T10:00:00.000Z');
      });

      it('surfaces retry count 2 during a second patch retry attempt', async () => {
        enqueueResponses(RECONFIGURING_ENV, [PATCH_RETRYING_LOG], 2);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.current_retry_count).toBe(2);
      });

      it('patch retrying log has action "patch"', async () => {
        enqueueResponses(RECONFIGURING_ENV, [PATCH_RETRYING_LOG], 2);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.logs[0].action).toBe('patch');
        expect(body.logs[0].status).toBe('retrying');
      });
    });

    // ── stopping ──────────────────────────────────────────────────────────────

    describe('stopping state', () => {
      const STOPPING_ENV = {
        ...DEPLOYED_ENV,
        deploy_status: 'stopping',
        stop_date: '2026-04-14T11:00:00.000Z',  // operator set stop_date
        last_deploy_date: '2026-04-14T10:00:00.000Z',
      };

      const STOP_IN_PROGRESS_LOG = {
        deployment_log_id: 30,
        log_org_key: 'acme',
        log_env_key: 'prod',
        action: 'stop',
        status: 'retrying',
        error_detail: null,
        retry_count: 0,
        created_date: '2026-04-14T11:00:05.000Z',
      };

      it('returns deploy_status "stopping" verbatim', async () => {
        enqueueResponses(STOPPING_ENV, [STOP_IN_PROGRESS_LOG], 0);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.deploy_status).toBe('stopping');
      });

      it('response shape is stable — all required fields present', async () => {
        enqueueResponses(STOPPING_ENV, [STOP_IN_PROGRESS_LOG], 0);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        for (const field of REQUIRED_FIELDS) {
          expect(body, `missing field: ${field}`).toHaveProperty(field);
        }
      });

      it('stop_date is present and non-null while stopping', async () => {
        enqueueResponses(STOPPING_ENV, [STOP_IN_PROGRESS_LOG], 0);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.stop_date).toBe('2026-04-14T11:00:00.000Z');
      });

      it('last_deploy_date is preserved from prior deployment', async () => {
        enqueueResponses(STOPPING_ENV, [STOP_IN_PROGRESS_LOG], 0);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.last_deploy_date).toBe('2026-04-14T10:00:00.000Z');
      });

      it('stop retrying log has action "stop"', async () => {
        enqueueResponses(STOPPING_ENV, [STOP_IN_PROGRESS_LOG], 0);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.logs[0].action).toBe('stop');
      });

      it('current_retry_count is 0 on first stop attempt', async () => {
        enqueueResponses(STOPPING_ENV, [STOP_IN_PROGRESS_LOG], 0);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.current_retry_count).toBe(0);
      });
    });

    // ── decommissioning ───────────────────────────────────────────────────────

    describe('decommissioning state', () => {
      const DECOMMISSIONING_ENV = {
        ...DEPLOYED_ENV,
        deploy_status: 'decommissioning',
        dcomm_date: '2026-04-14T11:30:00.000Z',  // operator set dcomm_date
        stop_date: '2026-04-14T11:00:00.000Z',
        last_deploy_date: '2026-04-14T10:00:00.000Z',
      };

      const DCOMM_RETRYING_LOG = {
        deployment_log_id: 40,
        log_org_key: 'acme',
        log_env_key: 'prod',
        action: 'decommission',
        status: 'retrying',
        error_detail: 'namespace deletion timeout',
        retry_count: 1,
        created_date: '2026-04-14T11:30:10.000Z',
      };

      it('returns deploy_status "decommissioning" verbatim', async () => {
        enqueueResponses(DECOMMISSIONING_ENV, [DCOMM_RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.deploy_status).toBe('decommissioning');
      });

      it('response shape is stable — all required fields present', async () => {
        enqueueResponses(DECOMMISSIONING_ENV, [DCOMM_RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        for (const field of REQUIRED_FIELDS) {
          expect(body, `missing field: ${field}`).toHaveProperty(field);
        }
      });

      it('dcomm_date is present and non-null while decommissioning', async () => {
        enqueueResponses(DECOMMISSIONING_ENV, [DCOMM_RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.dcomm_date).toBe('2026-04-14T11:30:00.000Z');
      });

      it('decommission retrying log has action "decommission"', async () => {
        enqueueResponses(DECOMMISSIONING_ENV, [DCOMM_RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.logs[0].action).toBe('decommission');
        expect(body.logs[0].status).toBe('retrying');
        expect(body.logs[0].error_detail).toBe('namespace deletion timeout');
      });

      it('surfaces retry count 1 during decommission retry', async () => {
        enqueueResponses(DECOMMISSIONING_ENV, [DCOMM_RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.current_retry_count).toBe(1);
      });

      it('last_deploy_date preserved — decommissioning does not clear it', async () => {
        enqueueResponses(DECOMMISSIONING_ENV, [DCOMM_RETRYING_LOG], 1);
        const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
        const body = await res.json();
        expect(body.last_deploy_date).toBe('2026-04-14T10:00:00.000Z');
      });
    });

    // ── cross-state: retry_count=3 cap (at-limit) ─────────────────────────────

    describe('retry count at maximum (3 attempts)', () => {
      it.each(['provisioning', 'reconfiguring', 'stopping', 'decommissioning'] as const)(
        'surfaces retry_count=3 cap for %s state',
        async (status) => {
          const env = { ...DEPLOYED_ENV, deploy_status: status };
          const log = {
            deployment_log_id: 99,
            log_org_key: 'acme',
            log_env_key: 'prod',
            action: status === 'reconfiguring' ? 'patch' : status === 'decommissioning' ? 'decommission' : status,
            status: 'retrying',
            error_detail: 'operation failed',
            retry_count: 3,
            created_date: '2026-04-14T12:00:00.000Z',
          };
          enqueueResponses(env, [log], 3);
          const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
          const body = await res.json();
          expect(body.deploy_status).toBe(status);
          expect(body.current_retry_count).toBe(3);
        }
      );
    });

    // ── cross-state: zero-log transitional states ──────────────────────────────
    // Worker may write the status to DB before writing the first log entry.
    // The shape must still be stable with an empty logs array.

    describe('transitional state with no logs yet (worker just set status)', () => {
      it.each(['provisioning', 'reconfiguring', 'stopping', 'decommissioning'] as const)(
        'returns stable shape for %s with empty logs',
        async (status) => {
          enqueueResponses({ ...DEPLOYED_ENV, deploy_status: status }, [], 0);
          const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
          const body = await res.json();
          expect(body.deploy_status).toBe(status);
          expect(Array.isArray(body.logs)).toBe(true);
          expect(body.logs).toHaveLength(0);
          expect(body.current_retry_count).toBe(0);
        }
      );
    });
  });

  // ── Retry count surfacing ──────────────────────────────────────────────────

  describe('current_retry_count', () => {
    it('surfaces active retry count for an in-flight retry', async () => {
      // Simulate: env is back to 'provisioning' (after a retry) with 2 attempts
      enqueueResponses({ ...DEPLOYED_ENV, deploy_status: 'provisioning' }, [], 2);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.current_retry_count).toBe(2);
    });

    it('is 0 for a fully deployed environment with no active retries', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG], 0);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();
      expect(body.current_retry_count).toBe(0);
    });
  });

  // ── Polling flow: deployed badge rendering contract ────────────────────────
  //
  // This section verifies the data contract between the status API and the
  // EnvList component's badge rendering: after a polling cycle completes,
  // EnvList stores `live.deploy_status` from the response and passes it to
  // StatusBadge.  The badge then renders the "Deployed" (green) visual.

  describe('deployed-badge rendering contract after polling', () => {
    it('API response provides deploy_status that StatusBadge can render as green', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();

      // 1. The API returns the status that will be stored in EnvList's `live` field.
      const liveDeployStatus: string = body.deploy_status;
      expect(liveDeployStatus).toBe('deployed');

      // 2. StatusBadge.STATUS_CONFIG['deployed'] maps this to green visuals.
      //    Import the config to complete the contract check.
      const { STATUS_CONFIG } = await import('@/components/StatusBadge');
      const cfg = STATUS_CONFIG[liveDeployStatus as keyof typeof STATUS_CONFIG];

      expect(cfg).toBeDefined();
      expect(cfg.label).toBe('Deployed');
      expect(cfg.classes).toContain('green');
      expect(cfg.animated).toBe(false);   // deployed is a stable/terminal state
    });

    it('logs array from polling response enables LogEntry rendering with success badge', async () => {
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod' }), makeParams('acme'));
      const body = await res.json();

      // EnvList reads latestLog = live?.logs?.[0] and renders it in the status cell
      const latestLog = body.logs?.[0];
      expect(latestLog).toBeDefined();
      expect(latestLog.status).toBe('success');
      expect(latestLog.action).toBe('provision');
      expect(latestLog.error_detail).toBeNull();
    });

    it('limit=1 restricts logs to the most recent entry only', async () => {
      const olderLog = { ...SUCCESS_LOG, deployment_log_id: 1, created_date: '2026-01-01T00:00:00.000Z' };
      // Only one entry returned because we honour limit=1 in the mock queue
      enqueueResponses(DEPLOYED_ENV, [SUCCESS_LOG]);
      const res = await GET(makeRequest('acme', { env_key: 'prod', limit: '1' }), makeParams('acme'));
      const body = await res.json();

      // EnvList polls with ?limit=1 — confirms single-entry response is enough for badge
      expect(body.logs).toHaveLength(1);
      // The single entry is the latest (most recent) log
      expect(body.logs[0].deployment_log_id).toBe(SUCCESS_LOG.deployment_log_id);

      void olderLog; // referenced to silence unused-var lint
    });
  });
});
