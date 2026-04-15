/**
 * E2E integration tests: dcomm_date set → decommissioned worker flow
 *
 * Covers Sub-AC 3 (decommission teardown) requirements:
 *   1. Worker picks up envs with elapsed dcomm_date via pollOnce()
 *   2. Calls decommissionEnv() with the correct env record
 *   3. On success: transitions deploy_status to 'decommissioned' (no timestamp flags)
 *   4. On success: writes a 'success' deployment_log entry
 *   5. On failure: retries up to MAX_RETRIES (3) with exponential backoff
 *   6. After MAX_RETRIES exhausted: marks env 'failed' and writes 'failed' log
 *   7. Cross-restart retry: reads prior retry count from deployment_log via getRetryCount
 *   8. If prior retries already at MAX_RETRIES, marks failed without re-running decommissionEnv
 *   9. Skips decommission when dcomm_date is null
 *  10. Skips decommission when dcomm_date is in the future
 *  11. Decommissions envs regardless of current deploy_status (deployed, stopped, failed)
 *  12. Multi-env: processes each decommission sequentially; continues if one fails
 *
 * All external dependencies (DB, kubectl, K8s, provisioner, decommissioner) are mocked
 * so these tests run without a live cluster or database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomerEnv } from '@/db/types';

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
  patchDeploymentReplicas: vi.fn().mockResolvedValue(undefined),
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
  getRetryCount,
} from '../db-worker';
import { sleep } from '../k8s';
import { decommissionEnv } from '../decommissioner';

// ---------------------------------------------------------------------------
// Helper: cast vi mocks
// ---------------------------------------------------------------------------
function asMock<T>(fn: T) {
  return fn as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** An elapsed dcomm_date — 1 hour in the past */
const PAST_DCOMM = new Date(Date.now() - 60 * 60 * 1000).toISOString();

/** A future dcomm_date — 1 hour from now */
const FUTURE_DCOMM = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function makeDeployedEnv(overrides: Partial<CustomerEnv> = {}): CustomerEnv {
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
    deploy_status: 'deployed',
    created_date: new Date().toISOString(),
    mod_date: new Date().toISOString(),
    last_deploy_date: new Date().toISOString(),
    stop_date: null,
    dcomm_date: PAST_DCOMM,
    last_applied_config: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Happy-path: elapsed dcomm_date → decommissioned
// ---------------------------------------------------------------------------

describe('pollOnce — decommission flow (dcomm_date elapsed → decommissioned)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(getPendingEnvs).mockResolvedValue([]);
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(decommissionEnv).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
  });

  it('calls decommissionEnv when dcomm_date has elapsed', async () => {
    const env = makeDeployedEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledOnce();
    expect(decommissionEnv).toHaveBeenCalledWith(env);
  });

  it('transitions deploy_status to decommissioned on success', async () => {
    const env = makeDeployedEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'decommissioned');
  });

  it('does NOT pass timestamp flags when transitioning to decommissioned', async () => {
    // Decommission preserves the operator-set dcomm_date — only status changes.
    const env = makeDeployedEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    // setEnvStatus should be called with exactly 3 args — no 4th options object
    const calls = asMock(setEnvStatus).mock.calls;
    const decommCall = calls.find((c) => c[2] === 'decommissioned');
    expect(decommCall).toBeDefined();
    expect(decommCall).toHaveLength(3); // [org_key, env_key, 'decommissioned']
  });

  it('writes a success log entry after decommission completes (retry_count=1)', async () => {
    const env = makeDeployedEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    // First attempt is attempt index 0, retry_count written as attempt + 1 = 1
    expect(writeLog).toHaveBeenCalledWith('acme', 'prod', 'decommission', 'success', null, 1);
  });

  it('decommissions a stopped env when dcomm_date has elapsed', async () => {
    const env = makeDeployedEnv({
      deploy_status: 'stopped',
      stop_date: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      dcomm_date: PAST_DCOMM,
    });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledOnce();
    expect(decommissionEnv).toHaveBeenCalledWith(env);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'decommissioned');
  });

  it('decommissions a failed env when dcomm_date has elapsed', async () => {
    // Operators may schedule teardown of failed environments
    const env = makeDeployedEnv({
      deploy_status: 'failed',
      dcomm_date: PAST_DCOMM,
    });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledOnce();
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'decommissioned');
  });

  it('consults getRetryCount with action=decommission before running', async () => {
    const env = makeDeployedEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(getRetryCount).toHaveBeenCalledWith('acme', 'prod', 'decommission');
  });
});

// ---------------------------------------------------------------------------
// 2. Temporal gate — dcomm_date must be set AND elapsed
// ---------------------------------------------------------------------------

describe('pollOnce — decommission temporal gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(decommissionEnv).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
  });

  it('does NOT decommission when dcomm_date is null', async () => {
    const env = makeDeployedEnv({ dcomm_date: null });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(decommissionEnv).not.toHaveBeenCalled();
    expect(setEnvStatus).not.toHaveBeenCalled();
  });

  it('does NOT decommission when dcomm_date is in the future', async () => {
    const env = makeDeployedEnv({ dcomm_date: FUTURE_DCOMM });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(decommissionEnv).not.toHaveBeenCalled();
    expect(setEnvStatus).not.toHaveBeenCalled();
  });

  it('decommissions when dcomm_date is exactly now (boundary: elapsed ≤ now)', async () => {
    // Use a timestamp just barely in the past to simulate "now"
    const justNow = new Date(Date.now() - 1).toISOString();
    const env = makeDeployedEnv({ dcomm_date: justNow });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledOnce();
  });

  it('does nothing when there are no envs in the result set', async () => {
    asMock(getPendingEnvs).mockResolvedValue([]);

    await pollOnce();

    expect(decommissionEnv).not.toHaveBeenCalled();
    expect(setEnvStatus).not.toHaveBeenCalled();
    expect(writeLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Retry behavior with exponential backoff
// ---------------------------------------------------------------------------

describe('pollOnce — decommission retry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(getPendingEnvs).mockResolvedValue([makeDeployedEnv()]);
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
  });

  it('retries decommissionEnv up to 3 times on persistent failure', async () => {
    asMock(decommissionEnv).mockRejectedValue(new Error('k8s timeout'));

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledTimes(3);
  });

  it('sleeps between retry attempts with exponential backoff', async () => {
    asMock(decommissionEnv).mockRejectedValue(new Error('transient error'));

    await pollOnce();

    // 3 attempts → 2 sleeps (after attempt 1 and 2; no sleep after final failure)
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('marks env as failed after all 3 retries are exhausted', async () => {
    asMock(decommissionEnv).mockRejectedValue(new Error('persistent error'));

    await pollOnce();

    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
  });

  it('writes a failed log entry when all retries are exhausted', async () => {
    asMock(decommissionEnv).mockRejectedValue(new Error('persistent error'));

    await pollOnce();

    expect(writeLog).toHaveBeenLastCalledWith(
      'acme',
      'prod',
      'decommission',
      'failed',
      'persistent error',
      3,
    );
  });

  it('writes retrying log entries for each non-final failure', async () => {
    asMock(decommissionEnv).mockRejectedValue(new Error('transient error'));

    await pollOnce();

    // 2 retrying entries (after attempt 1 and 2), then 1 failed entry
    const retryingCalls = asMock(writeLog).mock.calls.filter((c) => c[3] === 'retrying');
    expect(retryingCalls).toHaveLength(2);
  });

  it('succeeds on the second attempt — deploys to decommissioned after one retry', async () => {
    asMock(decommissionEnv)
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce(undefined);

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'decommissioned');
  });

  it('succeeds on the third attempt — two sleeps, then decommissioned', async () => {
    asMock(decommissionEnv)
      .mockRejectedValueOnce(new Error('error 1'))
      .mockRejectedValueOnce(new Error('error 2'))
      .mockResolvedValueOnce(undefined);

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'decommissioned');
  });

  it('does NOT call setEnvStatus(decommissioned) when all retries are exhausted', async () => {
    asMock(decommissionEnv).mockRejectedValue(new Error('always fails'));

    await pollOnce();

    const decommCalls = asMock(setEnvStatus).mock.calls.filter((c) => c[2] === 'decommissioned');
    expect(decommCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-restart retry tracking via deployment_log
// ---------------------------------------------------------------------------

describe('pollOnce — decommission cross-restart retry tracking via getRetryCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(getPendingEnvs).mockResolvedValue([makeDeployedEnv()]);
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
  });

  it('immediately marks failed without running decommissionEnv when prior retries = MAX_RETRIES (3)', async () => {
    // Worker crashed after recording 3 retrying entries in deployment_log.
    // On restart, prior_retries=3 → cap reached → skip fn(), mark failed.
    asMock(getRetryCount).mockResolvedValue(3);

    await pollOnce();

    expect(decommissionEnv).not.toHaveBeenCalled();
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
    expect(writeLog).toHaveBeenCalledWith(
      'acme',
      'prod',
      'decommission',
      'failed',
      expect.stringContaining('Retry cap'),
      3,
    );
  });

  it('resumes from attempt index 2 when prior retries = 2 (1 try remaining)', async () => {
    // Worker crashed after 2 retries. On restart, prior_retries=2 → start at
    // attempt=2 → exactly 1 more attempt allowed before marking failed.
    asMock(getRetryCount).mockResolvedValue(2);
    asMock(decommissionEnv).mockRejectedValue(new Error('still failing'));

    await pollOnce();

    // Only 1 attempt allowed (the 3rd), then marked failed
    expect(decommissionEnv).toHaveBeenCalledTimes(1);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
    // No sleep between retries — last attempt goes directly to failed
    expect(sleep).not.toHaveBeenCalled();
  });

  it('writes the correct retry_count in the failed log when resuming at attempt 2', async () => {
    asMock(getRetryCount).mockResolvedValue(2);
    asMock(decommissionEnv).mockRejectedValue(new Error('final attempt error'));

    await pollOnce();

    // attempt=2 (0-indexed), retry_count = attempt + 1 = 3 in the log
    expect(writeLog).toHaveBeenCalledWith(
      'acme',
      'prod',
      'decommission',
      'failed',
      'final attempt error',
      3,
    );
  });

  it('succeeds on the resumed attempt when prior retries = 1', async () => {
    // Worker crashed after 1 retry. Resumes at attempt=1 → 2 tries left.
    asMock(getRetryCount).mockResolvedValue(1);
    asMock(decommissionEnv).mockResolvedValue(undefined); // succeeds on first resumed attempt

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledOnce();
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'decommissioned');
    // retry_count = attempt + 1 = 1 + 1 = 2
    expect(writeLog).toHaveBeenCalledWith('acme', 'prod', 'decommission', 'success', null, 2);
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-env sequential processing
// ---------------------------------------------------------------------------

describe('pollOnce — sequential decommission of multiple envs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(decommissionEnv).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
  });

  it('decommissions all envs with elapsed dcomm_date in a single poll cycle', async () => {
    const env1 = makeDeployedEnv({ org_key: 'acme', env_key: 'prod' });
    const env2 = makeDeployedEnv({ org_key: 'beta', env_key: 'staging' });
    asMock(getPendingEnvs).mockResolvedValue([env1, env2]);

    await pollOnce();

    expect(decommissionEnv).toHaveBeenCalledTimes(2);
    expect(decommissionEnv).toHaveBeenCalledWith(env1);
    expect(decommissionEnv).toHaveBeenCalledWith(env2);
  });

  it('continues to decommission the second env even if the first exhausts all retries', async () => {
    const env1 = makeDeployedEnv({ org_key: 'acme', env_key: 'prod' });
    const env2 = makeDeployedEnv({ org_key: 'beta', env_key: 'staging' });
    asMock(getPendingEnvs).mockResolvedValue([env1, env2]);

    // env1 always fails; env2 always succeeds
    asMock(decommissionEnv)
      .mockRejectedValueOnce(new Error('env1 error'))
      .mockRejectedValueOnce(new Error('env1 error'))
      .mockRejectedValueOnce(new Error('env1 error'))
      .mockResolvedValueOnce(undefined); // env2 success

    await pollOnce();

    // 3 attempts for env1, 1 for env2
    expect(decommissionEnv).toHaveBeenCalledTimes(4);
    // env1 → failed, env2 → decommissioned
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
    expect(setEnvStatus).toHaveBeenCalledWith('beta', 'staging', 'decommissioned');
  });

  it('skips decommission for envs with future dcomm_date while processing others', async () => {
    const envReady = makeDeployedEnv({ org_key: 'acme', env_key: 'prod', dcomm_date: PAST_DCOMM });
    const envNotYet = makeDeployedEnv({
      org_key: 'beta',
      env_key: 'staging',
      dcomm_date: FUTURE_DCOMM,
    });
    asMock(getPendingEnvs).mockResolvedValue([envReady, envNotYet]);

    await pollOnce();

    // Only envReady should be decommissioned
    expect(decommissionEnv).toHaveBeenCalledTimes(1);
    expect(decommissionEnv).toHaveBeenCalledWith(envReady);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'decommissioned');
    // envNotYet must not be touched
    const betaCalls = asMock(setEnvStatus).mock.calls.filter((c) => c[0] === 'beta');
    expect(betaCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. K8s resource cleanup verification (decommissionEnv is the cleanup contract)
// ---------------------------------------------------------------------------

describe('pollOnce — K8s resource cleanup via decommissionEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(getRetryCount).mockResolvedValue(0);
  });

  it('decommissionEnv receives the full env record for K8s resource lookup', async () => {
    const env = makeDeployedEnv({
      org_key: 'customerX',
      env_key: 'staging',
      image: 'dotcms/dotcms:25.02',
      replicas: 3,
    });
    asMock(getPendingEnvs).mockResolvedValue([env]);
    asMock(decommissionEnv).mockResolvedValue(undefined);

    await pollOnce();

    // The env record must be passed unmodified — decommissioner needs
    // org_key and env_key to derive namespace, deployment name, PVC, etc.
    expect(decommissionEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        org_key: 'customerX',
        env_key: 'staging',
        image: 'dotcms/dotcms:25.02',
        replicas: 3,
      }),
    );
  });

  it('marks decommissioned only after decommissionEnv resolves successfully', async () => {
    let decommResolveFn!: () => void;
    const decommPromise = new Promise<void>((resolve) => {
      decommResolveFn = resolve;
    });

    const callOrder: string[] = [];
    asMock(decommissionEnv).mockImplementation(async () => {
      callOrder.push('decommissionEnv');
      await decommPromise;
    });
    asMock(setEnvStatus).mockImplementation(async (_org, _env, status) => {
      callOrder.push(`setEnvStatus:${status}`);
    });

    // Resolve before pollOnce resolves
    decommResolveFn();
    const env = makeDeployedEnv();
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    const decommIdx = callOrder.indexOf('decommissionEnv');
    const statusIdx = callOrder.indexOf('setEnvStatus:decommissioned');
    expect(decommIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(decommIdx);
  });
});
