/**
 * E2E integration tests: pending → provisioning → deployed worker flow
 *
 * Covers Sub-AC 2 requirements:
 *   1. Worker picks up 'pending' record via pollOnce()
 *   2. Transitions status to 'provisioning' before executing steps
 *   3. Calls provisionEnv() with the correct env record
 *   4. On success: transitions status to 'deployed' with last_deploy_date
 *   5. On success: saves last_applied_config watermark
 *   6. On success: writes a 'success' deployment_log entry
 *   7. On failure: retries up to MAX_RETRIES (3) with exponential backoff
 *   8. After MAX_RETRIES exhausted: marks env 'failed' and writes 'failed' log
 *   9. Crash recovery: recoverStuckProvisioningRows called every cycle
 *  10. Cross-restart retry: reads prior retry count from deployment_log via getRetryCount
 *  11. If prior retries already at MAX_RETRIES, marks failed without re-running provisionEnv
 *
 * All external dependencies (DB, kubectl, K8s, provisioner) are mocked so
 * these tests run without a live cluster or database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomerEnv, AppliedConfig } from '@/db/types';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any imports that depend on them
// ---------------------------------------------------------------------------

vi.mock('../db-worker', () => ({
  getPendingEnvs: vi.fn(),
  setEnvStatus: vi.fn(),
  writeLog: vi.fn(),
  updateWorkerTimestamp: vi.fn(),
  recoverStuckProvisioningRows: vi.fn().mockResolvedValue(0),
  recoverStuckReconfiguringRows: vi.fn().mockResolvedValue(0),
  detectAndEnqueueStops: vi.fn().mockResolvedValue([]),
  detectAndEnqueueReconfigs: vi.fn().mockResolvedValue([]),
  updateLastAppliedConfig: vi.fn().mockResolvedValue(undefined),
  getRetryCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('../k8s', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  kubectlApplyKustomize: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  execInPod: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('../provisioner', () => ({
  provisionEnv: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../decommissioner', () => ({
  decommissionEnv: vi.fn().mockResolvedValue(undefined),
  scaleDownEnv: vi.fn().mockResolvedValue(undefined),
}));

// Import subjects under test AFTER vi.mock() declarations
import { pollOnce } from '../poll';
import {
  getPendingEnvs,
  setEnvStatus,
  writeLog,
  updateLastAppliedConfig,
  recoverStuckProvisioningRows,
  getRetryCount,
} from '../db-worker';
import { sleep } from '../k8s';
import { provisionEnv } from '../provisioner';

// ---------------------------------------------------------------------------
// Helper: cast vi mocks
// ---------------------------------------------------------------------------
function asMock<T>(fn: T) {
  return fn as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makePendingEnv(overrides: Partial<CustomerEnv> = {}): CustomerEnv {
  return {
    org_key: 'acme',
    env_key: 'prod',
    cluster_id: 'hetzner-1',
    region_id: 'eu-central',
    image: 'dotcms/dotcms:24.01',
    replicas: 2,
    memory_req: '1Gi',
    memory_limit: '2Gi',
    cpu_req: '500m',
    cpu_limit: '1000m',
    env_vars: {},
    deploy_status: 'pending',
    created_date: new Date().toISOString(),
    mod_date: new Date().toISOString(),
    last_deploy_date: null,
    stop_date: null,
    dcomm_date: null,
    last_applied_config: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Happy-path: pending → provisioning → deployed
// ---------------------------------------------------------------------------

describe('pollOnce — provision flow (pending → deployed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: all setup helpers no-op
    asMock(getPendingEnvs).mockResolvedValue([]);
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(provisionEnv).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
    asMock(recoverStuckProvisioningRows).mockResolvedValue(0);
  });

  it('picks up a pending env and calls provisionEnv with it', async () => {
    const env = makePendingEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(provisionEnv).toHaveBeenCalledOnce();
    expect(provisionEnv).toHaveBeenCalledWith(env);
  });

  it('transitions status to provisioning before executing provision steps', async () => {
    const env = makePendingEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    // Track call order: setEnvStatus('provisioning') must come before provisionEnv
    const callOrder: string[] = [];
    asMock(setEnvStatus).mockImplementation(async (_org, _env, status) => {
      callOrder.push(`setEnvStatus:${status}`);
    });
    asMock(provisionEnv).mockImplementation(async () => {
      callOrder.push('provisionEnv');
    });

    await pollOnce();

    const provisioningIdx = callOrder.indexOf('setEnvStatus:provisioning');
    const provisionIdx = callOrder.indexOf('provisionEnv');
    expect(provisioningIdx).toBeGreaterThanOrEqual(0);
    expect(provisionIdx).toBeGreaterThan(provisioningIdx);
  });

  it('transitions status to deployed with last_deploy_date on success', async () => {
    const env = makePendingEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
  });

  it('saves last_applied_config snapshot on successful provision', async () => {
    const env = makePendingEnv({
      image: 'dotcms/dotcms:24.01',
      replicas: 2,
      memory_req: '1Gi',
      memory_limit: '2Gi',
      cpu_req: '500m',
      cpu_limit: '1000m',
      env_vars: {},
    });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(updateLastAppliedConfig).toHaveBeenCalledWith('acme', 'prod', {
      image: 'dotcms/dotcms:24.01',
      replicas: 2,
      memory_req: '1Gi',
      memory_limit: '2Gi',
      cpu_req: '500m',
      cpu_limit: '1000m',
      env_vars: {},
    } satisfies AppliedConfig);
  });

  it('writes a success log entry after provision completes (retry_count=1)', async () => {
    const env = makePendingEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    // First attempt is attempt index 0, retry_count written as attempt + 1 = 1
    expect(writeLog).toHaveBeenCalledWith('acme', 'prod', 'provision', 'success', null, 1);
  });

  it('snapshot includes env_vars when set', async () => {
    const env = makePendingEnv({
      env_vars: { API_KEY: 'secret', REGION: 'eu-central' },
    });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(updateLastAppliedConfig).toHaveBeenCalledWith(
      'acme',
      'prod',
      expect.objectContaining({ env_vars: { API_KEY: 'secret', REGION: 'eu-central' } }),
    );
  });

  it('does nothing when there are no pending envs', async () => {
    asMock(getPendingEnvs).mockResolvedValue([]);

    await pollOnce();

    expect(provisionEnv).not.toHaveBeenCalled();
    expect(setEnvStatus).not.toHaveBeenCalled();
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('does NOT provision a deployed env that has no elapsed dcomm_date', async () => {
    const env = makePendingEnv({ deploy_status: 'deployed', dcomm_date: null });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(provisionEnv).not.toHaveBeenCalled();
    expect(setEnvStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Retry behavior with exponential backoff
// ---------------------------------------------------------------------------

describe('pollOnce — provision retry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(getPendingEnvs).mockResolvedValue([makePendingEnv()]);
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
    asMock(recoverStuckProvisioningRows).mockResolvedValue(0);
  });

  it('retries provisionEnv up to 3 times on persistent failure', async () => {
    asMock(provisionEnv).mockRejectedValue(new Error('k8s timeout'));

    await pollOnce();

    expect(provisionEnv).toHaveBeenCalledTimes(3);
  });

  it('sleeps between retry attempts with exponential backoff', async () => {
    asMock(provisionEnv).mockRejectedValue(new Error('transient error'));

    await pollOnce();

    // 3 attempts → 2 sleeps (after attempt 1 and 2; no sleep after final failure)
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('marks env as failed after all 3 retries are exhausted', async () => {
    asMock(provisionEnv).mockRejectedValue(new Error('persistent error'));

    await pollOnce();

    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
  });

  it('writes a failed log entry when all retries are exhausted', async () => {
    asMock(provisionEnv).mockRejectedValue(new Error('persistent error'));

    await pollOnce();

    expect(writeLog).toHaveBeenLastCalledWith(
      'acme',
      'prod',
      'provision',
      'failed',
      'persistent error',
      3,
    );
  });

  it('writes retrying log entries for each non-final failure', async () => {
    asMock(provisionEnv).mockRejectedValue(new Error('transient error'));

    await pollOnce();

    // 2 retrying entries (after attempt 1 and 2), then 1 failed entry
    const retryingCalls = asMock(writeLog).mock.calls.filter((c) => c[3] === 'retrying');
    expect(retryingCalls).toHaveLength(2);
  });

  it('succeeds on the second attempt — only one failed sleep, then deployed', async () => {
    asMock(provisionEnv)
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce(undefined);

    await pollOnce();

    expect(provisionEnv).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
    expect(updateLastAppliedConfig).toHaveBeenCalledOnce();
  });

  it('succeeds on the third attempt — two failed sleeps, then deployed', async () => {
    asMock(provisionEnv)
      .mockRejectedValueOnce(new Error('error 1'))
      .mockRejectedValueOnce(new Error('error 2'))
      .mockResolvedValueOnce(undefined);

    await pollOnce();

    expect(provisionEnv).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
  });

  it('does NOT call updateLastAppliedConfig when provision fails all retries', async () => {
    asMock(provisionEnv).mockRejectedValue(new Error('persistent error'));

    await pollOnce();

    expect(updateLastAppliedConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Crash recovery: recoverStuckProvisioningRows
// ---------------------------------------------------------------------------

describe('pollOnce — crash recovery for stuck provisioning rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(provisionEnv).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
  });

  it('calls recoverStuckProvisioningRows on every poll cycle', async () => {
    asMock(getPendingEnvs).mockResolvedValue([]);

    await pollOnce();

    expect(recoverStuckProvisioningRows).toHaveBeenCalledOnce();
  });

  it('calls recoverStuckProvisioningRows even when no envs need provisioning', async () => {
    asMock(getPendingEnvs).mockResolvedValue([]);
    asMock(recoverStuckProvisioningRows).mockResolvedValue(0);

    await pollOnce();
    await pollOnce();

    expect(recoverStuckProvisioningRows).toHaveBeenCalledTimes(2);
  });

  it('recovered env is provisioned in the same cycle after being reset to pending', async () => {
    // Simulate: crash recovery reset a provisioning row to 'pending',
    // then getPendingEnvs returns it and the worker provisions it.
    asMock(recoverStuckProvisioningRows).mockResolvedValue(1); // 1 row recovered
    const recoveredEnv = makePendingEnv({ deploy_status: 'pending' });
    asMock(getPendingEnvs).mockResolvedValue([recoveredEnv]);

    await pollOnce();

    expect(provisionEnv).toHaveBeenCalledOnce();
    expect(provisionEnv).toHaveBeenCalledWith(recoveredEnv);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-restart retry tracking via deployment_log
// ---------------------------------------------------------------------------

describe('pollOnce — cross-restart retry tracking via getRetryCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(getPendingEnvs).mockResolvedValue([makePendingEnv()]);
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(recoverStuckProvisioningRows).mockResolvedValue(0);
  });

  it('consults getRetryCount before starting provision attempts', async () => {
    asMock(getRetryCount).mockResolvedValue(0);
    asMock(provisionEnv).mockResolvedValue(undefined);

    await pollOnce();

    expect(getRetryCount).toHaveBeenCalledWith('acme', 'prod', 'provision');
  });

  it('immediately marks failed without running provisionEnv when prior retries = MAX_RETRIES (3)', async () => {
    // Worker crashed after recording 3 retrying entries.
    // On restart, prior_retries = 3 → cap reached → skip fn(), mark failed.
    asMock(getRetryCount).mockResolvedValue(3);

    await pollOnce();

    expect(provisionEnv).not.toHaveBeenCalled();
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
    expect(writeLog).toHaveBeenCalledWith(
      'acme',
      'prod',
      'provision',
      'failed',
      expect.stringContaining('Retry cap'),
      3,
    );
  });

  it('resumes from attempt index 2 when prior retries = 2 (1 try remaining)', async () => {
    // Worker crashed after 2 retries. On restart, prior_retries=2 → start loop
    // at attempt=2 → exactly 1 more attempt allowed.
    asMock(getRetryCount).mockResolvedValue(2);
    asMock(provisionEnv).mockRejectedValue(new Error('still failing'));

    await pollOnce();

    // Only 1 attempt allowed (the 3rd one), then marked failed
    expect(provisionEnv).toHaveBeenCalledTimes(1);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
    // No sleep between retries — last attempt goes directly to failed
    expect(sleep).not.toHaveBeenCalled();
  });

  it('writes the correct retry_count in the failed log when resuming at attempt 2', async () => {
    asMock(getRetryCount).mockResolvedValue(2);
    asMock(provisionEnv).mockRejectedValue(new Error('final attempt error'));

    await pollOnce();

    // attempt=2 (0-indexed), retry_count=attempt+1=3 in the log
    expect(writeLog).toHaveBeenCalledWith(
      'acme',
      'prod',
      'provision',
      'failed',
      'final attempt error',
      3,
    );
  });

  it('succeeds on the resumed attempt when prior retries = 1', async () => {
    // Worker crashed after 1 retry. Resumes at attempt=1 → 2 tries left.
    asMock(getRetryCount).mockResolvedValue(1);
    asMock(provisionEnv).mockResolvedValue(undefined); // succeeds on first resumed attempt

    await pollOnce();

    expect(provisionEnv).toHaveBeenCalledOnce();
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
    expect(writeLog).toHaveBeenCalledWith('acme', 'prod', 'provision', 'success', null, 2);
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-env processing: processes each pending env sequentially
// ---------------------------------------------------------------------------

describe('pollOnce — sequential processing of multiple pending envs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(provisionEnv).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
    asMock(recoverStuckProvisioningRows).mockResolvedValue(0);
  });

  it('provisions all pending envs in a single poll cycle', async () => {
    const env1 = makePendingEnv({ org_key: 'acme', env_key: 'prod' });
    const env2 = makePendingEnv({ org_key: 'beta', env_key: 'staging' });
    asMock(getPendingEnvs).mockResolvedValue([env1, env2]);

    await pollOnce();

    expect(provisionEnv).toHaveBeenCalledTimes(2);
    expect(provisionEnv).toHaveBeenCalledWith(env1);
    expect(provisionEnv).toHaveBeenCalledWith(env2);
  });

  it('continues to provision the second env even if the first one fails all retries', async () => {
    const env1 = makePendingEnv({ org_key: 'acme', env_key: 'prod' });
    const env2 = makePendingEnv({ org_key: 'beta', env_key: 'staging' });
    asMock(getPendingEnvs).mockResolvedValue([env1, env2]);

    // env1 always fails; env2 always succeeds
    asMock(provisionEnv)
      .mockRejectedValueOnce(new Error('env1 error'))
      .mockRejectedValueOnce(new Error('env1 error'))
      .mockRejectedValueOnce(new Error('env1 error'))
      .mockResolvedValueOnce(undefined); // env2 success

    await pollOnce();

    // 3 attempts for env1, 1 for env2
    expect(provisionEnv).toHaveBeenCalledTimes(4);
    // env1 → failed, env2 → deployed
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
    expect(setEnvStatus).toHaveBeenCalledWith('beta', 'staging', 'deployed', {
      last_deploy_date: true,
    });
  });
});
