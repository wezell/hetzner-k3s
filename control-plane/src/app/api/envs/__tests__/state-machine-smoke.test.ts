/**
 * E2E State-Machine Smoke Test
 *
 * Integration test that exercises the full chain:
 *   DB mock → GET /api/envs/[id]/status route → response body → StatusBadge config
 *
 * Each test call mocks the DB to return a specific intermediate state, invokes
 * the real route handler (no HTTP server needed — Next.js route handlers are
 * plain async functions), reads deploy_status from the response body, and
 * asserts the correct StatusBadge config is resolved for that status.
 *
 * The four in-progress (transitional) states covered in a single round-trip:
 *   1. provisioning  — blue  animated  (pending → provisioning → deployed)
 *   2. reconfiguring — purple animated (deployed → reconfiguring → deployed)
 *   3. stopping      — orange animated (deployed → stopping → stopped)
 *   4. decommissioning — teal animated (stopped → decommissioning → decommissioned)
 *
 * All runs in a pure Node.js environment — no DOM, no jsdom, no React renderer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  STATUS_CONFIG,
  FALLBACK_CONFIG,
  type DeployStatus,
} from '@/components/StatusBadge';

// ---------------------------------------------------------------------------
// Mock postgres.js — same pattern as status-route.test.ts
// ---------------------------------------------------------------------------

const mockSql = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const fn = Object.assign(
    (..._args: unknown[]) => Promise.resolve(queue.shift() ?? []),
    { _queue: queue }
  );
  return fn;
});

vi.mock('@/db', () => ({ sql: mockSql }));

// ---------------------------------------------------------------------------
// Route handler (imported AFTER mock is registered)
// ---------------------------------------------------------------------------

const { GET } = await import('../[id]/status/route');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal customer_env DB row with the given deploy_status.
 */
function makeEnvRow(deployStatus: DeployStatus) {
  return {
    org_key: 'smoke',
    env_key: 'e2e',
    deploy_status: deployStatus,
    last_deploy_date: deployStatus === 'deployed' ? '2026-04-14T10:00:00.000Z' : null,
    stop_date: (deployStatus === 'stopped' || deployStatus === 'stopping') ? '2026-04-14T11:00:00.000Z' : null,
    dcomm_date: (deployStatus === 'decommissioning' || deployStatus === 'decommissioned') ? '2026-04-14T12:00:00.000Z' : null,
    mod_date: '2026-04-14T13:00:00.000Z',
  };
}

/**
 * Build a deployment_log entry for the given action and status.
 */
function makeLogEntry(
  action: 'provision' | 'patch' | 'stop' | 'decommission',
  logStatus: 'success' | 'failed' | 'retrying',
  id: number = 1
) {
  return {
    deployment_log_id: id,
    log_org_key: 'smoke',
    log_env_key: 'e2e',
    action,
    status: logStatus,
    error_detail: null,
    retry_count: 0,
    created_date: '2026-04-14T13:00:00.000Z',
  };
}

/**
 * Enqueue DB responses for the three SQL calls the status route makes:
 *   1. SELECT customer_env (the env row)
 *   2. SELECT deployment_log (log entries)
 *   3. Retry count CTE
 */
function enqueueState(deployStatus: DeployStatus, logEntries: object[] = [], retryCount = 0) {
  mockSql._queue.push([makeEnvRow(deployStatus)]);
  mockSql._queue.push(logEntries);
  mockSql._queue.push([{ current_retry_count: String(retryCount) }]);
}

/** Build a Next.js-compatible Request for the status route. */
function makeRequest(orgKey: string, envKey: string) {
  const url = new URL(`http://localhost/api/envs/${orgKey}/status`);
  url.searchParams.set('env_key', envKey);
  return new Request(url.toString());
}

/** Build the params arg Next.js passes alongside the request. */
function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Resolve the StatusBadge config for a deploy_status string.
 * Mirrors StatusBadge's internal lookup so we verify the full rendering chain.
 */
function resolveBadgeConfig(status: DeployStatus) {
  const cfg = STATUS_CONFIG[status];
  if (cfg) return cfg;
  return {
    label: FALLBACK_CONFIG.label(status),
    classes: FALLBACK_CONFIG.classes,
    dot: FALLBACK_CONFIG.dot,
    animated: FALLBACK_CONFIG.animated,
  };
}

/**
 * Call the real status route with a mocked DB state and return the parsed
 * response body together with the resolved badge config.
 */
async function roundTrip(deployStatus: DeployStatus, logEntries: object[] = [], retryCount = 0) {
  enqueueState(deployStatus, logEntries, retryCount);
  const res = await GET(makeRequest('smoke', 'e2e'), makeParams('smoke'));
  const body = await res.json() as { deploy_status: DeployStatus; [k: string]: unknown };
  const badge = resolveBadgeConfig(body.deploy_status);
  return { res, body, badge };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E state-machine smoke test', () => {
  beforeEach(() => {
    mockSql._queue.length = 0;
  });

  // ── Four transitional states: individual assertions ───────────────────────

  describe('provisioning — blue animated badge (pending → deployed)', () => {
    it('route returns deploy_status "provisioning"', async () => {
      const { body } = await roundTrip('provisioning', [
        makeLogEntry('provision', 'retrying'),
      ]);
      expect(body.deploy_status).toBe('provisioning');
    });

    it('badge label is "Provisioning"', async () => {
      const { badge } = await roundTrip('provisioning', [
        makeLogEntry('provision', 'retrying'),
      ]);
      expect(badge.label).toBe('Provisioning');
    });

    it('badge uses blue colour family', async () => {
      const { badge } = await roundTrip('provisioning', [
        makeLogEntry('provision', 'retrying'),
      ]);
      expect(badge.classes).toContain('blue');
      expect(badge.dot).toContain('blue');
    });

    it('badge is animated (worker active)', async () => {
      const { badge } = await roundTrip('provisioning', [
        makeLogEntry('provision', 'retrying'),
      ]);
      expect(badge.animated).toBe(true);
    });
  });

  describe('reconfiguring — purple animated badge (deployed → deployed)', () => {
    it('route returns deploy_status "reconfiguring"', async () => {
      const { body } = await roundTrip('reconfiguring', [
        makeLogEntry('patch', 'retrying'),
      ]);
      expect(body.deploy_status).toBe('reconfiguring');
    });

    it('badge label is "Reconfiguring"', async () => {
      const { badge } = await roundTrip('reconfiguring', [
        makeLogEntry('patch', 'retrying'),
      ]);
      expect(badge.label).toBe('Reconfiguring');
    });

    it('badge uses purple colour family', async () => {
      const { badge } = await roundTrip('reconfiguring', [
        makeLogEntry('patch', 'retrying'),
      ]);
      expect(badge.classes).toContain('purple');
      expect(badge.dot).toContain('purple');
    });

    it('badge is animated (worker active)', async () => {
      const { badge } = await roundTrip('reconfiguring', [
        makeLogEntry('patch', 'retrying'),
      ]);
      expect(badge.animated).toBe(true);
    });
  });

  describe('stopping — orange animated badge (deployed → stopped)', () => {
    it('route returns deploy_status "stopping"', async () => {
      const { body } = await roundTrip('stopping', [
        makeLogEntry('stop', 'retrying'),
      ]);
      expect(body.deploy_status).toBe('stopping');
    });

    it('badge label is "Stopping"', async () => {
      const { badge } = await roundTrip('stopping', [
        makeLogEntry('stop', 'retrying'),
      ]);
      expect(badge.label).toBe('Stopping');
    });

    it('badge uses orange colour family', async () => {
      const { badge } = await roundTrip('stopping', [
        makeLogEntry('stop', 'retrying'),
      ]);
      expect(badge.classes).toContain('orange');
      expect(badge.dot).toContain('orange');
    });

    it('badge is animated (worker active)', async () => {
      const { badge } = await roundTrip('stopping', [
        makeLogEntry('stop', 'retrying'),
      ]);
      expect(badge.animated).toBe(true);
    });
  });

  describe('decommissioning — teal animated badge (stopped → decommissioned)', () => {
    it('route returns deploy_status "decommissioning"', async () => {
      const { body } = await roundTrip('decommissioning', [
        makeLogEntry('decommission', 'retrying'),
      ]);
      expect(body.deploy_status).toBe('decommissioning');
    });

    it('badge label is "Decommissioning"', async () => {
      const { badge } = await roundTrip('decommissioning', [
        makeLogEntry('decommission', 'retrying'),
      ]);
      expect(badge.label).toBe('Decommissioning');
    });

    it('badge uses teal colour family', async () => {
      const { badge } = await roundTrip('decommissioning', [
        makeLogEntry('decommission', 'retrying'),
      ]);
      expect(badge.classes).toContain('teal');
      expect(badge.dot).toContain('teal');
    });

    it('badge is animated (worker active)', async () => {
      const { badge } = await roundTrip('decommissioning', [
        makeLogEntry('decommission', 'retrying'),
      ]);
      expect(badge.animated).toBe(true);
    });
  });

  // ── Single round-trip: all four transitional states in one test ───────────
  //
  // This is the core E2E smoke test.  We sequence DB snapshots through all
  // four in-progress states and confirm the route + badge chain is consistent
  // at every step without resetting or reloading.

  describe('single round-trip: all four transitional states in sequence', () => {
    it('routes each DB snapshot to the correct animated badge config', async () => {
      // Define the expected badge outcome for every transitional state.
      // Each entry: [status, expectedLabel, colourFamily]
      const sequence: Array<{
        status: DeployStatus;
        action: 'provision' | 'patch' | 'stop' | 'decommission';
        expectedLabel: string;
        expectedColour: string;
      }> = [
        { status: 'provisioning',   action: 'provision',   expectedLabel: 'Provisioning',   expectedColour: 'blue'   },
        { status: 'reconfiguring',  action: 'patch',       expectedLabel: 'Reconfiguring',  expectedColour: 'purple' },
        { status: 'stopping',       action: 'stop',        expectedLabel: 'Stopping',       expectedColour: 'orange' },
        { status: 'decommissioning',action: 'decommission',expectedLabel: 'Decommissioning',expectedColour: 'teal'   },
      ];

      for (const { status, action, expectedLabel, expectedColour } of sequence) {
        const { body, badge } = await roundTrip(status, [makeLogEntry(action, 'retrying')]);

        // Route passes DB status through unchanged
        expect(body.deploy_status).toBe(status);

        // Badge label matches state
        expect(badge.label).toBe(expectedLabel);

        // Colour family matches state
        expect(badge.classes).toContain(expectedColour);
        expect(badge.dot).toContain(expectedColour);

        // All four transitional states must be animated
        expect(badge.animated).toBe(true);
      }
    });

    it('every transitional state produces HTTP 200', async () => {
      const transitionalStates: DeployStatus[] = [
        'provisioning', 'reconfiguring', 'stopping', 'decommissioning',
      ];

      for (const status of transitionalStates) {
        enqueueState(status, [], 0);
        const res = await GET(makeRequest('smoke', 'e2e'), makeParams('smoke'));
        expect(res.status).toBe(200);
      }
    });

    it('each transitional state carries a current_retry_count in the response', async () => {
      const transitionalStates: DeployStatus[] = [
        'provisioning', 'reconfiguring', 'stopping', 'decommissioning',
      ];

      for (const status of transitionalStates) {
        enqueueState(status, [], 1);
        const res = await GET(makeRequest('smoke', 'e2e'), makeParams('smoke'));
        const body = await res.json() as { current_retry_count: number };
        expect(body.current_retry_count).toBe(1);
      }
    });
  });

  // ── Transitional → terminal transitions: animated then static ────────────
  //
  // Verifies the animated→static transition for each of the four paths
  // within a single describe block — the "single round-trip scenario" for
  // the complete lifecycle.

  describe('animated→static transitions for all four in-progress paths', () => {
    it('provisioning (animated) → deployed (static)', async () => {
      const { badge: during } = await roundTrip('provisioning', [makeLogEntry('provision', 'retrying')]);
      const { badge: after }  = await roundTrip('deployed',     [makeLogEntry('provision', 'success')]);

      expect(during.animated).toBe(true);
      expect(after.animated).toBe(false);
      expect(during.classes).toContain('blue');
      expect(after.classes).toContain('green');
    });

    it('reconfiguring (animated) → deployed (static)', async () => {
      const { badge: during } = await roundTrip('reconfiguring', [makeLogEntry('patch', 'retrying')]);
      const { badge: after }  = await roundTrip('deployed',      [makeLogEntry('patch', 'success')]);

      expect(during.animated).toBe(true);
      expect(after.animated).toBe(false);
      expect(during.classes).toContain('purple');
      expect(after.classes).toContain('green');
    });

    it('stopping (animated) → stopped (static)', async () => {
      const { badge: during } = await roundTrip('stopping', [makeLogEntry('stop', 'retrying')]);
      const { badge: after }  = await roundTrip('stopped',  [makeLogEntry('stop', 'success')]);

      expect(during.animated).toBe(true);
      expect(after.animated).toBe(false);
      expect(during.classes).toContain('orange');
      expect(after.classes).toContain('gray');
    });

    it('decommissioning (animated) → decommissioned (static)', async () => {
      const { badge: during } = await roundTrip('decommissioning', [makeLogEntry('decommission', 'retrying')]);
      const { badge: after }  = await roundTrip('decommissioned',  [makeLogEntry('decommission', 'success')]);

      expect(during.animated).toBe(true);
      expect(after.animated).toBe(false);
      expect(during.classes).toContain('teal');
      expect(after.classes).toContain('slate');
    });

    it('all four transitions in a single sequential pass', async () => {
      type Transition = {
        intermediate: DeployStatus;
        terminal: DeployStatus;
        action: 'provision' | 'patch' | 'stop' | 'decommission';
        intermediateColour: string;
        terminalColour: string;
      };

      const transitions: Transition[] = [
        { intermediate: 'provisioning',   terminal: 'deployed',      action: 'provision',   intermediateColour: 'blue',   terminalColour: 'green' },
        { intermediate: 'reconfiguring',  terminal: 'deployed',      action: 'patch',       intermediateColour: 'purple', terminalColour: 'green' },
        { intermediate: 'stopping',       terminal: 'stopped',       action: 'stop',        intermediateColour: 'orange', terminalColour: 'gray'  },
        { intermediate: 'decommissioning',terminal: 'decommissioned',action: 'decommission',intermediateColour: 'teal',   terminalColour: 'slate' },
      ];

      for (const { intermediate, terminal, action, intermediateColour, terminalColour } of transitions) {
        // In-progress: animated badge
        const { body: bodyDuring, badge: badgeDuring } = await roundTrip(
          intermediate, [makeLogEntry(action, 'retrying')]
        );
        expect(bodyDuring.deploy_status).toBe(intermediate);
        expect(badgeDuring.animated).toBe(true);
        expect(badgeDuring.classes).toContain(intermediateColour);

        // Terminal: static badge
        const { body: bodyAfter, badge: badgeAfter } = await roundTrip(
          terminal, [makeLogEntry(action, 'success')]
        );
        expect(bodyAfter.deploy_status).toBe(terminal);
        expect(badgeAfter.animated).toBe(false);
        expect(badgeAfter.classes).toContain(terminalColour);
      }
    });
  });

  // ── Retry count surfacing during in-progress states ───────────────────────

  describe('retry count surfaces correctly during transitional states', () => {
    it.each([
      ['provisioning',   0, 'provision'],
      ['provisioning',   1, 'provision'],
      ['provisioning',   2, 'provision'],
      ['reconfiguring',  1, 'patch'],
      ['stopping',       2, 'stop'],
      ['decommissioning',1, 'decommission'],
    ] as Array<[DeployStatus, number, 'provision' | 'patch' | 'stop' | 'decommission']>)(
      'status "%s" with retry count %d passes through unchanged',
      async (status, retryCount, action) => {
        enqueueState(status, [makeLogEntry(action, retryCount > 0 ? 'retrying' : 'retrying')], retryCount);
        const res = await GET(makeRequest('smoke', 'e2e'), makeParams('smoke'));
        const body = await res.json() as { deploy_status: DeployStatus; current_retry_count: number };

        expect(body.deploy_status).toBe(status);
        expect(body.current_retry_count).toBe(retryCount);

        // Badge is still animated regardless of retry depth
        const badge = resolveBadgeConfig(body.deploy_status);
        expect(badge.animated).toBe(true);
      }
    );
  });
});
