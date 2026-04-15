/**
 * Integration tests: detect → patch → apply → status flow
 *
 * Covers Sub-AC 3c requirements:
 *   1. Status transitions to 'deployed' on successful kubectl apply
 *   2. last_applied_config watermark is saved to prevent re-triggering
 *   3. Full detect → patch → apply → status flow
 *
 * External dependencies (DB, kubectl, K8s) are mocked so these tests run
 * without a live cluster or database.
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
  kubectlApplyKustomize: vi.fn(),
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

// Import the subjects under test AFTER vi.mock() declarations
import { pollOnce } from '../poll';
import {
  getPendingEnvs,
  setEnvStatus,
  writeLog,
  updateLastAppliedConfig,
  detectAndEnqueueReconfigs,
  recoverStuckReconfiguringRows,
} from '../db-worker';
import { kubectlApplyKustomize, sleep } from '../k8s';
import { kustomizeDeploymentPatch } from '../kustomize';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_APPLIED_CONFIG: AppliedConfig = {
  image: 'dotcms/dotcms:24.01',
  replicas: 2,
  memory_req: '1Gi',
  memory_limit: '2Gi',
  cpu_req: '500m',
  cpu_limit: '1000m',
  env_vars: {},
};

function makeEnv(overrides: Partial<CustomerEnv> = {}): CustomerEnv {
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
    deploy_status: 'reconfiguring',
    created_date: new Date().toISOString(),
    mod_date: new Date().toISOString(),
    last_deploy_date: null,
    stop_date: null,
    dcomm_date: null,
    last_applied_config: BASE_APPLIED_CONFIG,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper to cast mocked functions
// ---------------------------------------------------------------------------
function asMock<T>(fn: T) {
  return fn as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// 1. kustomizeDeploymentPatch — pure function unit tests
// ---------------------------------------------------------------------------

describe('kustomizeDeploymentPatch', () => {
  it('produces a strategic-merge-patch Deployment with correct metadata', () => {
    const env = makeEnv({ deploy_status: 'deployed' });
    const patch = kustomizeDeploymentPatch(env);

    expect(patch.apiVersion).toBe('apps/v1');
    expect(patch.kind).toBe('Deployment');
    expect((patch.metadata as { name: string; namespace: string }).name).toBe('acme-prod');
    expect((patch.metadata as { name: string; namespace: string }).namespace).toBe('acme');
  });

  it('sets replicas from env record', () => {
    const env = makeEnv({ replicas: 3 });
    const patch = kustomizeDeploymentPatch(env);

    expect((patch.spec as { replicas: number }).replicas).toBe(3);
  });

  it('sets image on the dotcms container', () => {
    const env = makeEnv({ image: 'dotcms/dotcms:25.01' });
    const patch = kustomizeDeploymentPatch(env);

    const spec = patch.spec as {
      template: { spec: { containers: Array<{ name: string; image: string }> } };
    };
    const container = spec.template.spec.containers.find((c) => c.name === 'dotcms');
    expect(container?.image).toBe('dotcms/dotcms:25.01');
  });

  it('sets CPU and memory resources', () => {
    const env = makeEnv({
      cpu_req: '250m',
      cpu_limit: '500m',
      memory_req: '512Mi',
      memory_limit: '1Gi',
    });
    const patch = kustomizeDeploymentPatch(env);

    const spec = patch.spec as {
      template: {
        spec: {
          containers: Array<{
            name: string;
            resources: {
              requests: { cpu: string; memory: string };
              limits: { cpu: string; memory: string };
            };
          }>;
        };
      };
    };
    const container = spec.template.spec.containers.find((c) => c.name === 'dotcms');
    expect(container?.resources.requests.cpu).toBe('250m');
    expect(container?.resources.requests.memory).toBe('512Mi');
    expect(container?.resources.limits.cpu).toBe('500m');
    expect(container?.resources.limits.memory).toBe('1Gi');
  });

  it('converts env_vars record to {name, value} array', () => {
    const env = makeEnv({
      env_vars: { DB_HOST: 'pg.local', LOG_LEVEL: 'debug' },
    });
    const patch = kustomizeDeploymentPatch(env);

    const spec = patch.spec as {
      template: {
        spec: { containers: Array<{ name: string; env?: Array<{ name: string; value: string }> }> };
      };
    };
    const container = spec.template.spec.containers.find((c) => c.name === 'dotcms');
    expect(container?.env).toEqual(
      expect.arrayContaining([
        { name: 'DB_HOST', value: 'pg.local' },
        { name: 'LOG_LEVEL', value: 'debug' },
      ]),
    );
  });

  it('omits env array when env_vars is empty', () => {
    const env = makeEnv({ env_vars: {} });
    const patch = kustomizeDeploymentPatch(env);

    const spec = patch.spec as {
      template: { spec: { containers: Array<{ name: string; env?: unknown }> } };
    };
    const container = spec.template.spec.containers.find((c) => c.name === 'dotcms');
    expect(container).not.toHaveProperty('env');
  });

  it('omits cpu from limits when cpu_limit is falsy', () => {
    const env = makeEnv({ cpu_limit: '' });
    const patch = kustomizeDeploymentPatch(env);

    const spec = patch.spec as {
      template: {
        spec: {
          containers: Array<{
            name: string;
            resources: { limits: Record<string, string> };
          }>;
        };
      };
    };
    const container = spec.template.spec.containers.find((c) => c.name === 'dotcms');
    expect(container?.resources.limits).not.toHaveProperty('cpu');
  });
});

// ---------------------------------------------------------------------------
// 2. pollOnce — reconfiguring env patch flow integration tests
// ---------------------------------------------------------------------------

describe('pollOnce — patch flow (reconfiguring → deployed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all setup calls succeed with no-op results
    asMock(getPendingEnvs).mockResolvedValue([]);
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(detectAndEnqueueReconfigs).mockResolvedValue([]);
    asMock(recoverStuckReconfiguringRows).mockResolvedValue(0);
    asMock(kubectlApplyKustomize).mockResolvedValue({
      stdout: 'deployment.apps/acme-prod configured',
      stderr: '',
    });
  });

  it('applies kustomize patch for a reconfiguring env on success', async () => {
    const env = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(kubectlApplyKustomize).toHaveBeenCalledOnce();
    // The patch argument should be a valid Deployment spec
    const patchArg = asMock(kubectlApplyKustomize).mock.calls[0][0] as Record<string, unknown>;
    expect(patchArg.kind).toBe('Deployment');
    expect(patchArg.apiVersion).toBe('apps/v1');
  });

  it('transitions status to deployed on successful kubectl apply', async () => {
    const env = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
  });

  it('saves last_applied_config watermark on success to prevent re-triggering', async () => {
    const env = makeEnv({
      deploy_status: 'reconfiguring',
      image: 'dotcms/dotcms:25.01',
      replicas: 3,
      memory_req: '2Gi',
      memory_limit: '4Gi',
      cpu_req: '1000m',
      cpu_limit: '2000m',
      env_vars: { FEATURE_FLAG: 'on' },
    });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(updateLastAppliedConfig).toHaveBeenCalledWith('acme', 'prod', {
      image: 'dotcms/dotcms:25.01',
      replicas: 3,
      memory_req: '2Gi',
      memory_limit: '4Gi',
      cpu_req: '1000m',
      cpu_limit: '2000m',
      env_vars: { FEATURE_FLAG: 'on' },
    } satisfies AppliedConfig);
  });

  it('writes a success log entry after patch completes', async () => {
    const env = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    // AC 8 changed retry tracking to 1-indexed attempt numbers — success on
    // the first attempt is recorded as retry_count=1 (attempt + 1 where attempt=0).
    expect(writeLog).toHaveBeenCalledWith('acme', 'prod', 'patch', 'success', null, 1);
  });

  it('does NOT call updateLastAppliedConfig on failure', async () => {
    const env = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([env]);
    asMock(kubectlApplyKustomize).mockRejectedValue(new Error('kubectl timeout'));

    await pollOnce();

    expect(updateLastAppliedConfig).not.toHaveBeenCalled();
  });

  it('retries patch up to 3 times before marking failed', async () => {
    const env = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([env]);
    asMock(kubectlApplyKustomize).mockRejectedValue(new Error('connection refused'));

    await pollOnce();

    // 3 attempts = 3 kubectl calls
    expect(kubectlApplyKustomize).toHaveBeenCalledTimes(3);
    // Sleep called between retries (attempt 1 → delay, attempt 2 → delay, attempt 3 → done)
    expect(sleep).toHaveBeenCalledTimes(2);
    // Marked as failed after exhausting retries
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'failed');
  });

  it('writes a failed log entry when all retries are exhausted', async () => {
    const env = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([env]);
    asMock(kubectlApplyKustomize).mockRejectedValue(new Error('connection refused'));

    await pollOnce();

    expect(writeLog).toHaveBeenLastCalledWith(
      'acme',
      'prod',
      'patch',
      'failed',
      'connection refused',
      3,
    );
  });

  it('succeeds on the second attempt after one failure', async () => {
    const env = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([env]);
    asMock(kubectlApplyKustomize)
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce({ stdout: 'configured', stderr: '' });

    await pollOnce();

    expect(kubectlApplyKustomize).toHaveBeenCalledTimes(2);
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
    expect(updateLastAppliedConfig).toHaveBeenCalledOnce();
  });

  it('skips patch for deployed env with no drift — only pending handled', async () => {
    // A 'deployed' env appears in the list (for dcomm_date check) but has no
    // elapsed dcomm_date and is NOT 'reconfiguring' → no patch should run.
    const env = makeEnv({
      deploy_status: 'deployed',
      dcomm_date: null,
      last_applied_config: BASE_APPLIED_CONFIG,
    });
    asMock(getPendingEnvs).mockResolvedValue([env]);

    await pollOnce();

    expect(kubectlApplyKustomize).not.toHaveBeenCalled();
    expect(setEnvStatus).not.toHaveBeenCalled();
    expect(updateLastAppliedConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. detectAndEnqueueReconfigs — config drift detection contract
// ---------------------------------------------------------------------------

describe('detectAndEnqueueReconfigs — contract', () => {
  /**
   * These tests verify the contract between the drift-detection function
   * and the rest of the worker by checking that the mock behaves consistently
   * with the real function's documented behaviour.
   *
   * The SQL internals are covered by the database-level assertions; here we
   * test the integration boundary: if detectAndEnqueueReconfigs enqueues an
   * env, the next getPendingEnvs call must return it in 'reconfiguring' status.
   */

  beforeEach(() => {
    vi.clearAllMocks();
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(kubectlApplyKustomize).mockResolvedValue({ stdout: 'configured', stderr: '' });
  });

  it('enqueued env transitions fully: detect → reconfiguring → deployed', async () => {
    // Simulate detect cycle: detectAndEnqueueReconfigs returns 1 enqueued env
    const driftedEnv = makeEnv({
      deploy_status: 'reconfiguring', // already transitioned by drift detector
      image: 'dotcms/dotcms:25.02',   // new image triggers drift
    });

    // The detector ran (or will run) and enqueued this env
    asMock(detectAndEnqueueReconfigs).mockResolvedValue([
      { org_key: 'acme', env_key: 'prod' },
    ]);
    // getPendingEnvs returns the env in reconfiguring status (as DB state would be)
    asMock(getPendingEnvs).mockResolvedValue([driftedEnv]);

    await pollOnce();

    // Full flow: patch applied, status → deployed, config snapshotted
    expect(kubectlApplyKustomize).toHaveBeenCalledOnce();
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
    expect(updateLastAppliedConfig).toHaveBeenCalledWith(
      'acme',
      'prod',
      expect.objectContaining({ image: 'dotcms/dotcms:25.02' }),
    );
  });

  it('does not re-trigger after watermark is saved (simulate two poll cycles)', async () => {
    // Cycle 1: env has drift, gets enqueued and patched
    const driftedEnv = makeEnv({
      deploy_status: 'reconfiguring',
      replicas: 4, // drift from baseline of 2
    });
    asMock(detectAndEnqueueReconfigs).mockResolvedValueOnce([{ org_key: 'acme', env_key: 'prod' }]);
    asMock(getPendingEnvs).mockResolvedValueOnce([driftedEnv]);

    await pollOnce();

    // After cycle 1: watermark saved, no further triggers expected
    expect(updateLastAppliedConfig).toHaveBeenCalledOnce();

    // Cycle 2: drift detector finds nothing (watermark matches live config)
    asMock(detectAndEnqueueReconfigs).mockResolvedValueOnce([]);
    asMock(getPendingEnvs).mockResolvedValueOnce([]);

    await pollOnce();

    // kubectl was only called once — no re-patch on cycle 2
    expect(kubectlApplyKustomize).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. recoverStuckReconfiguringRows — crash recovery
// ---------------------------------------------------------------------------

describe('recoverStuckReconfiguringRows — crash recovery contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(setEnvStatus).mockResolvedValue(undefined);
    asMock(writeLog).mockResolvedValue(undefined);
    asMock(updateLastAppliedConfig).mockResolvedValue(undefined);
    asMock(kubectlApplyKustomize).mockResolvedValue({ stdout: 'configured', stderr: '' });
  });

  it('pollOnce calls recoverStuckReconfiguringRows on every cycle', async () => {
    asMock(getPendingEnvs).mockResolvedValue([]);

    await pollOnce();

    expect(recoverStuckReconfiguringRows).toHaveBeenCalledOnce();
  });

  it('recovered env is re-detected and re-patched in the same cycle', async () => {
    // Simulate: crash recovery reset a row to 'deployed', then drift detection
    // re-enqueued it as 'reconfiguring', and now pollOnce picks it up for patching.
    asMock(recoverStuckReconfiguringRows).mockResolvedValue(1); // 1 row recovered
    const recoveredEnv = makeEnv({ deploy_status: 'reconfiguring' });
    asMock(getPendingEnvs).mockResolvedValue([recoveredEnv]);
    asMock(detectAndEnqueueReconfigs).mockResolvedValue([{ org_key: 'acme', env_key: 'prod' }]);

    await pollOnce();

    expect(kubectlApplyKustomize).toHaveBeenCalledOnce();
    expect(setEnvStatus).toHaveBeenCalledWith('acme', 'prod', 'deployed', {
      last_deploy_date: true,
    });
  });
});
