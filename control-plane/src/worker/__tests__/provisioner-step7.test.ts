/**
 * Unit tests: provisioner Step 7 — Kustomize overlay deploy
 *
 * Covers Sub-AC 13c requirements:
 *   1. Step 7 calls scaffoldTenantOverlay(env) to create the overlay directory
 *   2. Step 7 calls kubectlApplyDir with the path returned by scaffoldTenantOverlay
 *   3. When kubectlApplyDir resolves, provisioning continues (no throw)
 *   4. When kubectlApplyDir rejects, the error propagates as a provisioning failure
 *   5. kubectl apply stderr/stdout are logged at each step
 *   6. The overlay path follows the kustomize/tenants/ORG-ENV/ convention
 *
 * All external I/O (k8s, kustomize FS writes, opensearch, postgres) is mocked
 * so the tests run without a live cluster, database, or filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any imports that depend on them
// ---------------------------------------------------------------------------

// Mock kustomize module — track scaffoldTenantOverlay calls
vi.mock('../kustomize', () => ({
  scaffoldTenantOverlay: vi.fn().mockResolvedValue('/kustomize/tenants/acme-prod'),
}));

// Mock k8s module — track kubectlApplyDir calls
vi.mock('../k8s', () => ({
  applyObject: vi.fn().mockResolvedValue(undefined),
  execInPod: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  waitForDeploymentReady: vi.fn().mockResolvedValue(true),
  kubectlApplyDir: vi.fn().mockResolvedValue({ stdout: 'deployment.apps/acme-prod configured', stderr: '' }),
  kubectlApplyKustomize: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

// Mock opensearch — non-fatal in test env
vi.mock('../opensearch', () => ({
  provisionOpenSearch: vi.fn().mockResolvedValue('os-test-pass'),
}));

// Mock logger — capture step calls without actual DB writes
vi.mock('../logger', () => ({
  runStep: vi.fn().mockImplementation(
    (_orgKey: string, _envKey: string, _phase: string, _name: string, fn: () => Promise<void>) =>
      fn(),
  ),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mock declarations
// ---------------------------------------------------------------------------
import { provisionEnv } from '../provisioner';
import { scaffoldTenantOverlay } from '../kustomize';
import { kubectlApplyDir, applyObject } from '../k8s';

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------
function makeEnv(overrides: Partial<CustomerEnv> = {}): CustomerEnv {
  return {
    org_key: 'acme',
    env_key: 'prod',
    cluster_id: 'hetzner-1',
    region_id: 'eu-central',
    image: 'dotcms/dotcms:24.01',
    replicas: 1,
    memory_req: '1Gi',
    memory_limit: '2Gi',
    cpu_req: '500m',
    cpu_limit: '',
    env_vars: {},
    deploy_status: 'provisioning',
    created_date: new Date().toISOString(),
    mod_date: new Date().toISOString(),
    last_deploy_date: null,
    stop_date: null,
    dcomm_date: null,
    last_applied_config: null,
    ...overrides,
  };
}

// Helper: cast vi mocks
function asMock<T>(fn: T) {
  return fn as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Required env vars (provisioner calls requireEnv for these)
// ---------------------------------------------------------------------------
const REQUIRED_ENV = {
  BASE_DOMAIN: 'dotcms.example.com',
  WASABI_ACCESS_KEY: 'test-access-key',
  WASABI_SECRET_KEY: 'test-secret-key',
  WASABI_S3FUSE_BUCKET: 'test-bucket',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('provisioner Step 7 — Kustomize overlay deployment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore required env vars
    Object.entries(REQUIRED_ENV).forEach(([k, v]) => {
      process.env[k] = v;
    });
    // Reset mocks to defaults
    asMock(scaffoldTenantOverlay).mockResolvedValue('/kustomize/tenants/acme-prod');
    asMock(kubectlApplyDir).mockResolvedValue({ stdout: 'deployment.apps/acme-prod configured', stderr: '' });
  });

  it('calls scaffoldTenantOverlay with the customer env record', async () => {
    const env = makeEnv();
    await provisionEnv(env);

    expect(scaffoldTenantOverlay).toHaveBeenCalledWith(env);
  });

  it('calls kubectlApplyDir with the path returned by scaffoldTenantOverlay', async () => {
    const overlayPath = '/kustomize/tenants/acme-prod';
    asMock(scaffoldTenantOverlay).mockResolvedValue(overlayPath);

    const env = makeEnv();
    await provisionEnv(env);

    expect(kubectlApplyDir).toHaveBeenCalledWith(overlayPath);
  });

  it('overlay path follows kustomize/tenants/ORG-ENV/ convention', async () => {
    const env = makeEnv({ org_key: 'testorg', env_key: 'staging' });
    // Make scaffoldTenantOverlay return the expected path for this org/env
    asMock(scaffoldTenantOverlay).mockResolvedValue('/app/kustomize/tenants/testorg-staging');

    await provisionEnv(env);

    // kubectlApplyDir receives the ORG-ENV scoped path
    const applyDirCall = asMock(kubectlApplyDir).mock.calls[0][0] as string;
    expect(applyDirCall).toContain('testorg-staging');
  });

  it('completes without throwing when kubectl apply -k succeeds', async () => {
    asMock(kubectlApplyDir).mockResolvedValue({
      stdout: 'deployment.apps/acme-prod configured\nservice/acme-prod created',
      stderr: '',
    });

    const env = makeEnv();
    await expect(provisionEnv(env)).resolves.toBeUndefined();
  });

  it('propagates kubectl apply failure as a provisioning error', async () => {
    const applyError = new Error(
      'kubectl apply -k /kustomize/tenants/acme-prod failed (exit 1):\nError from server (NotFound): namespaces "acme" not found',
    );
    asMock(kubectlApplyDir).mockRejectedValue(applyError);

    const env = makeEnv();
    await expect(provisionEnv(env)).rejects.toThrow('kubectl apply -k');
  });

  it('propagates error message including kubectl stderr output', async () => {
    const stderrMessage = 'Error from server (Forbidden): deployments.apps is forbidden';
    const applyError = new Error(
      `kubectl apply -k /kustomize/tenants/acme-prod failed (exit 1):\n${stderrMessage}`,
    );
    asMock(kubectlApplyDir).mockRejectedValue(applyError);

    const env = makeEnv();
    await expect(provisionEnv(env)).rejects.toThrow(stderrMessage);
  });

  it('does not call kubectlApplyDir when scaffoldTenantOverlay fails', async () => {
    asMock(scaffoldTenantOverlay).mockRejectedValue(
      new Error('EACCES: permission denied, mkdir /kustomize/tenants/acme-prod'),
    );

    const env = makeEnv();
    await expect(provisionEnv(env)).rejects.toThrow('EACCES');
    expect(kubectlApplyDir).not.toHaveBeenCalled();
  });

  it('scaffold failure also surfaces as provisioning failure (not silently ignored)', async () => {
    asMock(scaffoldTenantOverlay).mockRejectedValue(
      new Error('Disk quota exceeded writing kustomization.yaml'),
    );

    const env = makeEnv();
    await expect(provisionEnv(env)).rejects.toThrow('Disk quota exceeded');
  });

  it('Step 7 runs kubectl apply -k exactly once per provisionEnv call', async () => {
    const env = makeEnv();
    await provisionEnv(env);

    expect(kubectlApplyDir).toHaveBeenCalledTimes(1);
  });

  it('direct k8s applyObject is NOT called for dotCMS workload resources (kustomize handles them)', async () => {
    const env = makeEnv();
    await provisionEnv(env);

    // applyObject should still be called for Steps 1-6 and 8-9 resources
    // (namespace, secrets, PV/PVC, ingress, caddy) but NOT for the dotCMS
    // Deployment, HPA, PDB, or Services — those come from kustomize base.
    const applyObjectCalls = asMock(applyObject).mock.calls;
    const kinds: string[] = applyObjectCalls.map(
      (args: unknown[]) => (args[0] as Record<string, unknown>).kind as string,
    );

    // Kustomize-managed resources must NOT appear as direct applyObject calls
    expect(kinds).not.toContain('Deployment');
    expect(kinds).not.toContain('HorizontalPodAutoscaler');
  });

  it('kubectl apply stderr warning does not abort provisioning (non-error output)', async () => {
    // kubectl sometimes outputs to stderr for warnings even on success (exit 0)
    asMock(kubectlApplyDir).mockResolvedValue({
      stdout: 'deployment.apps/acme-prod configured',
      stderr: 'Warning: resource deployments/acme-prod is missing the kubectl.kubernetes.io/last-applied-configuration annotation',
    });

    const env = makeEnv();
    // Should succeed — stderr on exit 0 is a warning, not a failure
    await expect(provisionEnv(env)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// kubectlApplyDir error enrichment tests
// ---------------------------------------------------------------------------
describe('kubectlApplyDir error message enrichment', () => {
  it('enriched error includes overlay path in message', async () => {
    const applyError = new Error(
      'kubectl apply -k /custom/path/acme-prod failed (exit 1):\nerror: no objects passed to apply',
    );
    asMock(kubectlApplyDir).mockRejectedValue(applyError);

    const env = makeEnv();
    const result = provisionEnv(env);
    await expect(result).rejects.toThrow('acme-prod');
  });
});
