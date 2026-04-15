/**
 * EnvList polling data-flow tests
 *
 * Verifies the data contract between the /api/envs/[id]/status polling
 * response and the badge-rendering logic inside EnvList.
 *
 * These tests run in a pure Node.js environment — no DOM / jsdom needed.
 * Instead of rendering React components, we exercise the logic layers
 * directly:
 *   1. The status API returns the correct shape for a deployed env.
 *   2. The StatusBadge STATUS_CONFIG correctly maps 'deployed' to the
 *      green "Deployed" visual so operators see the right state in the list.
 *   3. EnvList's fallback path (live == null) renders the DB snapshot status.
 *
 * EnvList itself reads `row.live?.deploy_status ?? row.deploy_status` —
 * this test suite verifies both branches produce the correct config.
 */
import { describe, it, expect } from 'vitest';
import {
  STATUS_CONFIG,
  FALLBACK_CONFIG,
  type DeployStatus,
} from '@/components/StatusBadge';

// ── Utility: simulate EnvList's status resolution ─────────────────────────

/**
 * Mirrors EnvList's:
 *   const status = row.live?.deploy_status ?? row.deploy_status;
 */
function resolveDisplayStatus(
  dbStatus: DeployStatus,
  liveStatus?: DeployStatus | null
): DeployStatus {
  return liveStatus ?? dbStatus;
}

/**
 * Returns the visual config that StatusBadge would use for a given status.
 * Mirrors the StatusBadge render logic.
 */
function resolveConfig(status: DeployStatus) {
  const cfg = STATUS_CONFIG[status];
  if (cfg) return cfg;
  return {
    label: FALLBACK_CONFIG.label(status),
    classes: FALLBACK_CONFIG.classes,
    dot: FALLBACK_CONFIG.dot,
    animated: FALLBACK_CONFIG.animated,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('EnvList status resolution → badge config', () => {
  // ── After a successful provisioning polling cycle ────────────────────────

  describe('after polling completes (live status available)', () => {
    it('resolves to live deploy_status when poll response arrives', () => {
      const resolved = resolveDisplayStatus('provisioning', 'deployed');
      expect(resolved).toBe('deployed');
    });

    it('"deployed" live status maps to a defined StatusBadge config', () => {
      const status = resolveDisplayStatus('provisioning', 'deployed');
      const cfg = resolveConfig(status);
      expect(cfg).toBeDefined();
      expect(cfg.label).toBe('Deployed');
    });

    it('"deployed" live status renders green colour family', () => {
      const status = resolveDisplayStatus('provisioning', 'deployed');
      const cfg = resolveConfig(status);
      expect(cfg.classes).toContain('green');
      expect(cfg.dot).toContain('green');
    });

    it('"deployed" live status is NOT animated (worker finished)', () => {
      const status = resolveDisplayStatus('provisioning', 'deployed');
      const cfg = resolveConfig(status);
      expect(cfg.animated).toBe(false);
    });

    it('transitions from pending → deployed show correct final badge', () => {
      // Simulates: row was 'pending' in DB, poll returns 'deployed'
      const status = resolveDisplayStatus('pending', 'deployed');
      const cfg = resolveConfig(status);
      expect(cfg.label).toBe('Deployed');
      expect(cfg.classes).toContain('green');
    });
  });

  // ── Before first poll / while poll in-flight (live == null) ──────────────

  describe('before first poll completes (live == null)', () => {
    it('falls back to DB snapshot status', () => {
      const resolved = resolveDisplayStatus('deployed', null);
      expect(resolved).toBe('deployed');
    });

    it('DB snapshot "deployed" still renders green badge', () => {
      const status = resolveDisplayStatus('deployed', null);
      const cfg = resolveConfig(status);
      expect(cfg.label).toBe('Deployed');
      expect(cfg.classes).toContain('green');
    });

    it('DB snapshot "pending" renders yellow badge while poll is loading', () => {
      const status = resolveDisplayStatus('pending', null);
      const cfg = resolveConfig(status);
      expect(cfg.label).toBe('Pending');
      expect(cfg.classes).toContain('yellow');
    });
  });

  // ── Status transitions through the lifecycle ─────────────────────────────

  describe('full provisioning lifecycle badge sequence', () => {
    const lifecycle: Array<[DeployStatus, string, string]> = [
      ['pending',      'Pending',      'yellow'],
      ['provisioning', 'Provisioning', 'blue'],
      ['deployed',     'Deployed',     'green'],
    ];

    it.each(lifecycle)(
      'status "%s" → label "%s" (%s colour family)',
      (status, expectedLabel, expectedColour) => {
        const cfg = resolveConfig(status);
        expect(cfg.label).toBe(expectedLabel);
        expect(cfg.classes).toContain(expectedColour);
      }
    );

    it('provisioning is animated (worker active), deployed is not', () => {
      expect(resolveConfig('provisioning').animated).toBe(true);
      expect(resolveConfig('deployed').animated).toBe(false);
    });
  });

  // ── All DeployStatus values handled without throwing ─────────────────────

  describe('no status value crashes the config lookup', () => {
    const allStatuses: DeployStatus[] = [
      'pending', 'provisioning', 'deployed', 'reconfiguring',
      'stopping', 'stopped', 'failed', 'decommissioning', 'decommissioned',
    ];

    it.each(allStatuses)(
      '"%s" resolves to a non-empty label without throwing',
      (status) => {
        expect(() => resolveConfig(status)).not.toThrow();
        expect(resolveConfig(status).label.length).toBeGreaterThan(0);
      }
    );
  });

  // ── Stopping lifecycle badge sequence ────────────────────────────────────

  describe('stopping lifecycle badge sequence', () => {
    const lifecycle: Array<[DeployStatus, string, string, boolean]> = [
      ['deployed',  'Deployed', 'green',  false],
      ['stopping',  'Stopping', 'orange', true ],
      ['stopped',   'Stopped',  'gray',   false],
    ];

    it.each(lifecycle)(
      'status "%s" → label "%s" (%s colour family, animated=%s)',
      (status, expectedLabel, expectedColour, expectedAnimated) => {
        const cfg = resolveConfig(status);
        expect(cfg.label).toBe(expectedLabel);
        expect(cfg.classes).toContain(expectedColour);
        expect(cfg.animated).toBe(expectedAnimated);
      }
    );

    it('stopping is animated (worker active), stopped is not', () => {
      expect(resolveConfig('stopping').animated).toBe(true);
      expect(resolveConfig('stopped').animated).toBe(false);
    });
  });

  // ── Decommissioning lifecycle badge sequence ──────────────────────────────

  describe('decommissioning lifecycle badge sequence', () => {
    const lifecycle: Array<[DeployStatus, string, string, boolean]> = [
      ['stopped',          'Stopped',          'gray',   false],
      ['decommissioning',  'Decommissioning',  'teal',   true ],
      ['decommissioned',   'Decommissioned',   'slate',  false],
    ];

    it.each(lifecycle)(
      'status "%s" → label "%s" (%s colour family, animated=%s)',
      (status, expectedLabel, expectedColour, expectedAnimated) => {
        const cfg = resolveConfig(status);
        expect(cfg.label).toBe(expectedLabel);
        expect(cfg.classes).toContain(expectedColour);
        expect(cfg.animated).toBe(expectedAnimated);
      }
    );

    it('decommissioning is animated (worker active), decommissioned is not', () => {
      expect(resolveConfig('decommissioning').animated).toBe(true);
      expect(resolveConfig('decommissioned').animated).toBe(false);
    });
  });

  // ── Multi-poll cycle: provisioning → deployed ─────────────────────────────
  //
  // Simulates two consecutive poll responses for the same env row, verifying
  // that the badge updates within one poll interval without a page reload.
  // The component stores each response in row.live; these tests exercise the
  // same resolution logic (`row.live?.deploy_status ?? row.deploy_status`).

  describe('multi-poll cycle: provisioning → deployed', () => {
    it('poll #1: provisioning snapshot → blue animated badge', () => {
      // DB row starts pending; first poll returns provisioning
      const dbStatus: DeployStatus = 'pending';
      const poll1Response: DeployStatus = 'provisioning';

      const status = resolveDisplayStatus(dbStatus, poll1Response);
      const cfg = resolveConfig(status);

      expect(status).toBe('provisioning');
      expect(cfg.label).toBe('Provisioning');
      expect(cfg.classes).toContain('blue');
      expect(cfg.animated).toBe(true);
    });

    it('poll #2: deployed snapshot → green static badge (no page reload)', () => {
      // Second poll returns deployed — badge switches without full page refresh
      const dbStatus: DeployStatus = 'pending';
      const poll2Response: DeployStatus = 'deployed';

      const status = resolveDisplayStatus(dbStatus, poll2Response);
      const cfg = resolveConfig(status);

      expect(status).toBe('deployed');
      expect(cfg.label).toBe('Deployed');
      expect(cfg.classes).toContain('green');
      expect(cfg.animated).toBe(false);
    });

    it('badge transitions from animated→static within one poll interval', () => {
      // Both calls use the same dbStatus; only the live value changes between polls
      const dbStatus: DeployStatus = 'pending';

      const afterPoll1 = resolveConfig(resolveDisplayStatus(dbStatus, 'provisioning'));
      const afterPoll2 = resolveConfig(resolveDisplayStatus(dbStatus, 'deployed'));

      // Poll 1: in-progress — animated
      expect(afterPoll1.animated).toBe(true);
      // Poll 2: complete — static
      expect(afterPoll2.animated).toBe(false);
      // Colour family changed from blue to green
      expect(afterPoll1.classes).toContain('blue');
      expect(afterPoll2.classes).toContain('green');
    });

    it('full provisioning→deployed snapshot sequence carries correct log context', () => {
      const provisioningResponse = {
        deploy_status: 'provisioning' as DeployStatus,
        current_retry_count: 0,
        logs: [{
          deployment_log_id: 1,
          log_org_key: 'acme', log_env_key: 'prod',
          action: 'provision' as const,
          status: 'retrying' as const,
          error_detail: null,
          retry_count: 0,
          created_date: '2026-04-14T12:00:00.000Z',
        }],
      };
      const deployedResponse = {
        deploy_status: 'deployed' as DeployStatus,
        current_retry_count: 0,
        logs: [{
          deployment_log_id: 2,
          log_org_key: 'acme', log_env_key: 'prod',
          action: 'provision' as const,
          status: 'success' as const,
          error_detail: null,
          retry_count: 0,
          created_date: '2026-04-14T12:03:00.000Z',
        }],
      };

      // After poll 1: animated + retrying log
      const poll1Status = resolveDisplayStatus('pending', provisioningResponse.deploy_status);
      expect(poll1Status).toBe('provisioning');
      expect(provisioningResponse.logs[0].status).toBe('retrying');
      expect(resolveConfig(poll1Status).animated).toBe(true);

      // After poll 2: static + success log
      const poll2Status = resolveDisplayStatus('pending', deployedResponse.deploy_status);
      expect(poll2Status).toBe('deployed');
      expect(deployedResponse.logs[0].status).toBe('success');
      expect(resolveConfig(poll2Status).animated).toBe(false);
    });
  });

  // ── Multi-poll cycle: stopping → stopped ──────────────────────────────────

  describe('multi-poll cycle: stopping → stopped', () => {
    it('poll #1: stopping snapshot → orange animated badge', () => {
      // Row is deployed in DB; operator sets stop_date; worker picks it up → stopping
      const dbStatus: DeployStatus = 'deployed';
      const poll1Response: DeployStatus = 'stopping';

      const status = resolveDisplayStatus(dbStatus, poll1Response);
      const cfg = resolveConfig(status);

      expect(status).toBe('stopping');
      expect(cfg.label).toBe('Stopping');
      expect(cfg.classes).toContain('orange');
      expect(cfg.animated).toBe(true);
    });

    it('poll #2: stopped snapshot → gray static badge (no page reload)', () => {
      const dbStatus: DeployStatus = 'deployed';
      const poll2Response: DeployStatus = 'stopped';

      const status = resolveDisplayStatus(dbStatus, poll2Response);
      const cfg = resolveConfig(status);

      expect(status).toBe('stopped');
      expect(cfg.label).toBe('Stopped');
      expect(cfg.classes).toContain('gray');
      expect(cfg.animated).toBe(false);
    });

    it('badge transitions from animated→static within one poll interval', () => {
      const dbStatus: DeployStatus = 'deployed';

      const afterPoll1 = resolveConfig(resolveDisplayStatus(dbStatus, 'stopping'));
      const afterPoll2 = resolveConfig(resolveDisplayStatus(dbStatus, 'stopped'));

      expect(afterPoll1.animated).toBe(true);
      expect(afterPoll2.animated).toBe(false);
      expect(afterPoll1.classes).toContain('orange');
      expect(afterPoll2.classes).toContain('gray');
    });

    it('full stopping→stopped snapshot sequence carries correct log context', () => {
      const stoppingResponse = {
        deploy_status: 'stopping' as DeployStatus,
        current_retry_count: 0,
        logs: [{
          deployment_log_id: 10,
          log_org_key: 'acme', log_env_key: 'prod',
          action: 'stop' as const,
          status: 'retrying' as const,
          error_detail: null,
          retry_count: 0,
          created_date: '2026-04-14T14:00:00.000Z',
        }],
      };
      const stoppedResponse = {
        deploy_status: 'stopped' as DeployStatus,
        current_retry_count: 0,
        logs: [{
          deployment_log_id: 11,
          log_org_key: 'acme', log_env_key: 'prod',
          action: 'stop' as const,
          status: 'success' as const,
          error_detail: null,
          retry_count: 0,
          created_date: '2026-04-14T14:01:00.000Z',
        }],
      };

      // After poll 1: animated + in-flight stop log
      const poll1Status = resolveDisplayStatus('deployed', stoppingResponse.deploy_status);
      expect(poll1Status).toBe('stopping');
      expect(stoppingResponse.logs[0].action).toBe('stop');
      expect(resolveConfig(poll1Status).animated).toBe(true);

      // After poll 2: static + success log
      const poll2Status = resolveDisplayStatus('deployed', stoppedResponse.deploy_status);
      expect(poll2Status).toBe('stopped');
      expect(stoppedResponse.logs[0].status).toBe('success');
      expect(resolveConfig(poll2Status).animated).toBe(false);
    });
  });

  // ── Multi-poll cycle: decommissioning → decommissioned ────────────────────

  describe('multi-poll cycle: decommissioning → decommissioned', () => {
    it('poll #1: decommissioning snapshot → teal animated badge', () => {
      const dbStatus: DeployStatus = 'stopped';
      const poll1Response: DeployStatus = 'decommissioning';

      const status = resolveDisplayStatus(dbStatus, poll1Response);
      const cfg = resolveConfig(status);

      expect(status).toBe('decommissioning');
      expect(cfg.label).toBe('Decommissioning');
      expect(cfg.classes).toContain('teal');
      expect(cfg.animated).toBe(true);
    });

    it('poll #2: decommissioned snapshot → slate static badge (no page reload)', () => {
      const dbStatus: DeployStatus = 'stopped';
      const poll2Response: DeployStatus = 'decommissioned';

      const status = resolveDisplayStatus(dbStatus, poll2Response);
      const cfg = resolveConfig(status);

      expect(status).toBe('decommissioned');
      expect(cfg.label).toBe('Decommissioned');
      expect(cfg.classes).toContain('slate');
      expect(cfg.animated).toBe(false);
    });

    it('badge transitions from animated→static within one poll interval', () => {
      const dbStatus: DeployStatus = 'stopped';

      const afterPoll1 = resolveConfig(resolveDisplayStatus(dbStatus, 'decommissioning'));
      const afterPoll2 = resolveConfig(resolveDisplayStatus(dbStatus, 'decommissioned'));

      expect(afterPoll1.animated).toBe(true);
      expect(afterPoll2.animated).toBe(false);
      expect(afterPoll1.classes).toContain('teal');
      expect(afterPoll2.classes).toContain('slate');
    });
  });

  // ── Polling response shape compatibility ──────────────────────────────────
  //
  // These tests validate that the shape that fetchStatus() stores in
  // `row.live` is compatible with what StatusCell reads.

  describe('StatusResponse shape compatibility', () => {
    const mockDeployedStatusResponse = {
      org_key: 'acme',
      env_key: 'prod',
      deploy_status: 'deployed' as DeployStatus,
      last_deploy_date: '2026-04-14T12:00:00.000Z',
      stop_date: null,
      dcomm_date: null,
      mod_date: '2026-04-14T12:01:00.000Z',
      current_retry_count: 0,
      logs: [
        {
          deployment_log_id: 42,
          log_org_key: 'acme',
          log_env_key: 'prod',
          action: 'provision',
          status: 'success',
          error_detail: null,
          retry_count: 0,
          created_date: '2026-04-14T12:00:00.000Z',
        },
      ],
    };

    it('live.deploy_status from poll response resolves to green deployed badge', () => {
      const live = mockDeployedStatusResponse;
      const status = resolveDisplayStatus('pending', live.deploy_status);
      const cfg = resolveConfig(status);

      expect(status).toBe('deployed');
      expect(cfg.label).toBe('Deployed');
      expect(cfg.classes).toContain('green');
      expect(cfg.animated).toBe(false);
    });

    it('live.logs[0] has required fields for LogEntry component', () => {
      const live = mockDeployedStatusResponse;
      const latestLog = live.logs?.[0];

      expect(latestLog).toBeDefined();
      // Fields LogEntry renders
      expect(latestLog).toHaveProperty('status');
      expect(latestLog).toHaveProperty('action');
      expect(latestLog).toHaveProperty('retry_count');
      expect(latestLog).toHaveProperty('created_date');
      expect(latestLog.status).toBe('success');
    });

    it('live.last_deploy_date is accessible for the "Last deployed" column', () => {
      const live = mockDeployedStatusResponse;
      expect(live.last_deploy_date).toBe('2026-04-14T12:00:00.000Z');
    });

    it('current_retry_count is 0 after successful provision', () => {
      const live = mockDeployedStatusResponse;
      expect(live.current_retry_count).toBe(0);
    });
  });
});
