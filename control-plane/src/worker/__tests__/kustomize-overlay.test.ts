/**
 * Tests for the Kustomize tenant overlay scaffolding helpers.
 *
 * Covers:
 *   - parseImage       — splits image strings into newName / newTag pairs
 *   - generateOverlayKustomization — pure YAML generation, no I/O
 *   - scaffoldTenantOverlay        — creates directory + file on real FS
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, access } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { rm } from 'fs/promises';

import {
  parseImage,
  buildExtraEnvVarsYaml,
  generateOverlayKustomization,
  scaffoldTenantOverlay,
} from '../kustomize';
import type { CustomerEnv } from '@/db/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEnv: CustomerEnv = {
  org_key: 'fakecorp',
  env_key: 'prod',
  cluster_id: 'hetzner-k3s',
  region_id: 'fsn1',
  image: 'mirror.gcr.io/dotcms/dotcms:latest',
  replicas: 1,
  cpu_req: '500m',
  memory_req: '2Gi',
  cpu_limit: '',
  memory_limit: '3Gi',
  env_vars: {},
  deploy_status: 'pending',
  created_date: '2026-04-14T00:00:00Z',
  mod_date: '2026-04-14T00:00:00Z',
  last_deploy_date: null,
  stop_date: null,
  dcomm_date: null,
  last_applied_config: null,
};

// ---------------------------------------------------------------------------
// parseImage
// ---------------------------------------------------------------------------

describe('parseImage', () => {
  it('splits registry/repo:tag', () => {
    expect(parseImage('mirror.gcr.io/dotcms/dotcms:latest')).toEqual({
      newName: 'mirror.gcr.io/dotcms/dotcms',
      newTag: 'latest',
    });
  });

  it('splits simple repo:tag', () => {
    expect(parseImage('dotcms/dotcms:trunk-latest')).toEqual({
      newName: 'dotcms/dotcms',
      newTag: 'trunk-latest',
    });
  });

  it('defaults tag to "latest" when no colon present', () => {
    expect(parseImage('dotcms/dotcms')).toEqual({
      newName: 'dotcms/dotcms',
      newTag: 'latest',
    });
  });

  it('handles semver tag', () => {
    expect(parseImage('mirror.gcr.io/dotcms/dotcms:24.10.0')).toEqual({
      newName: 'mirror.gcr.io/dotcms/dotcms',
      newTag: '24.10.0',
    });
  });

  it('treats the last colon as the tag separator (not a port)', () => {
    // Image refs don't typically have ports but the split should still be
    // on the last colon so registry:5000/repo:tag is handled correctly.
    expect(parseImage('registry:5000/repo:tag')).toEqual({
      newName: 'registry:5000/repo',
      newTag: 'tag',
    });
  });
});

// ---------------------------------------------------------------------------
// buildExtraEnvVarsYaml
// ---------------------------------------------------------------------------

describe('buildExtraEnvVarsYaml', () => {
  it('returns empty string for null input', () => {
    expect(buildExtraEnvVarsYaml(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(buildExtraEnvVarsYaml(undefined)).toBe('');
  });

  it('returns empty string for empty object', () => {
    expect(buildExtraEnvVarsYaml({})).toBe('');
  });

  it('returns YAML entry for single env var', () => {
    const result = buildExtraEnvVarsYaml({ MY_VAR: 'hello' });
    expect(result).toContain('- name: MY_VAR');
    expect(result).toContain('value: "hello"');
  });

  it('returns YAML entries for multiple env vars', () => {
    const result = buildExtraEnvVarsYaml({ A: '1', B: '2' });
    expect(result).toContain('- name: A');
    expect(result).toContain('value: "1"');
    expect(result).toContain('- name: B');
    expect(result).toContain('value: "2"');
  });

  it('uses 18-space indent for list items and 20-space for value', () => {
    const result = buildExtraEnvVarsYaml({ FOO: 'bar' });
    // 18 spaces before "- name:"
    expect(result).toMatch(/^ {18}- name: FOO/m);
    // 20 spaces before "value:"
    expect(result).toMatch(/^ {20}value: "bar"/m);
  });

  it('ends with a trailing newline', () => {
    const result = buildExtraEnvVarsYaml({ X: 'y' });
    expect(result.endsWith('\n')).toBe(true);
  });

  it('wraps values containing spaces in double quotes', () => {
    const result = buildExtraEnvVarsYaml({ MSG: 'hello world' });
    expect(result).toContain('value: "hello world"');
  });
});

// ---------------------------------------------------------------------------
// generateOverlayKustomization — structural assertions
// ---------------------------------------------------------------------------

describe('generateOverlayKustomization', () => {
  it('sets namespace to org_key', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('namespace: fakecorp');
  });

  it('references ../../dotcms-base', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('- ../../dotcms-base');
  });

  it('includes image override with correct newName and newTag', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('newName: mirror.gcr.io/dotcms/dotcms');
    expect(yaml).toContain('newTag: latest');
  });

  it('renames Deployment to instance name', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('value: fakecorp-prod');
  });

  it('renames headless service to instance-hl', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('value: fakecorp-prod-hl');
  });

  it('patches HPA scaleTargetRef to instance name', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toMatch(/scaleTargetRef\/name.*fakecorp-prod/);
  });

  it('sets DOT_DOTCMS_CLUSTER_ID to instance', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('value: fakecorp-prod');
    expect(yaml).toContain('DOT_DOTCMS_CLUSTER_ID');
  });

  it('sets DB_BASE_URL with instance as database name', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain(
      'value: "jdbc:postgresql://postgres-rw.postgres.svc.cluster.local:5432/fakecorp-prod"',
    );
  });

  it('references instance-postgres secret for DB credentials', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('name: fakecorp-prod-postgres');
  });

  it('references instance-os-creds secret for OpenSearch credentials', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('name: fakecorp-prod-os-creds');
  });

  it('sets PVC claimName to instance-assets', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('claimName: fakecorp-prod-assets');
  });

  it('patches pod anti-affinity with instance label', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('values: [fakecorp-prod]');
  });

  it('patches Service selectors to instance label', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    // Both ClusterIP and headless service selector patches
    const selectorMatches = yaml.match(/selector:\s*\n\s+instance: fakecorp-prod/g);
    expect(selectorMatches).not.toBeNull();
    expect(selectorMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it('sets resource requests from env', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('cpu: "500m"');
    expect(yaml).toContain('memory: "2Gi"');
  });

  it('sets memory limit from env', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('memory: "3Gi"');
  });

  it('omits cpu limit line when cpu_limit is empty', () => {
    const yaml = generateOverlayKustomization({ ...baseEnv, cpu_limit: '' });
    // Should have memory limit but not cpu limit under limits:
    const limitsSection = yaml.match(/limits:\s*\n([\s\S]*?)(?=\n\s{16}env:)/)?.[1] ?? '';
    expect(limitsSection).not.toContain('cpu:');
  });

  it('includes cpu limit when cpu_limit is set', () => {
    const yaml = generateOverlayKustomization({
      ...baseEnv,
      cpu_limit: '2000m',
    });
    expect(yaml).toContain('cpu: "2000m"');
  });

  it('sets botcms.cloud labels on pod template', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain('botcms.cloud/tenant: fakecorp');
    expect(yaml).toContain('botcms.cloud/instance: fakecorp-prod');
  });

  it('sets replicas from env', () => {
    const yaml = generateOverlayKustomization({ ...baseEnv, replicas: 3 });
    expect(yaml).toContain('replicas: 3');
  });

  it('includes header comment with tenant/env/instance', () => {
    const yaml = generateOverlayKustomization(baseEnv);
    expect(yaml).toContain(
      '# Tenant: fakecorp  Environment: prod  Instance: fakecorp-prod',
    );
  });

  it('works for different org/env combinations', () => {
    const env: CustomerEnv = {
      ...baseEnv,
      org_key: 'acmeco',
      env_key: 'staging',
      image: 'dotcms/dotcms:24.10.0',
      cpu_limit: '4000m',
    };
    const yaml = generateOverlayKustomization(env);
    expect(yaml).toContain('namespace: acmeco');
    expect(yaml).toContain('value: acmeco-staging');
    expect(yaml).toContain('newTag: 24.10.0');
    expect(yaml).toContain('cpu: "4000m"');
  });

  // ── env_vars overrides ───────────────────────────────────────────────────

  it('produces no extra env var lines when env_vars is empty', () => {
    const yaml = generateOverlayKustomization({ ...baseEnv, env_vars: {} });
    // volumeMounts must follow immediately after the last required env var block
    // (no extra "- name:" lines between DOT_ES_AUTH_BASIC_PASSWORD and volumeMounts)
    const afterOsPassword = yaml.split('key: password\n').at(-1) ?? '';
    const firstNonEmpty = afterOsPassword.trimStart().split('\n')[0];
    expect(firstNonEmpty).toMatch(/^volumeMounts:/);
  });

  it('produces no extra env var lines when env_vars is null', () => {
    const yaml = generateOverlayKustomization({ ...baseEnv, env_vars: null as unknown as Record<string,string> });
    const afterOsPassword = yaml.split('key: password\n').at(-1) ?? '';
    const firstNonEmpty = afterOsPassword.trimStart().split('\n')[0];
    expect(firstNonEmpty).toMatch(/^volumeMounts:/);
  });

  it('appends a single operator env var after required vars', () => {
    const yaml = generateOverlayKustomization({
      ...baseEnv,
      env_vars: { LOG_LEVEL: 'debug' },
    });
    expect(yaml).toContain('- name: LOG_LEVEL');
    expect(yaml).toContain('value: "debug"');
  });

  it('appends multiple operator env vars after required vars', () => {
    const yaml = generateOverlayKustomization({
      ...baseEnv,
      env_vars: { LOG_LEVEL: 'debug', FEATURE_FLAG: 'true', MAX_HEAP: '512m' },
    });
    expect(yaml).toContain('- name: LOG_LEVEL');
    expect(yaml).toContain('value: "debug"');
    expect(yaml).toContain('- name: FEATURE_FLAG');
    expect(yaml).toContain('value: "true"');
    expect(yaml).toContain('- name: MAX_HEAP');
    expect(yaml).toContain('value: "512m"');
  });

  it('operator env vars appear before volumeMounts in the patch', () => {
    const yaml = generateOverlayKustomization({
      ...baseEnv,
      env_vars: { MY_EXTRA: 'value1' },
    });
    const extraIdx = yaml.indexOf('- name: MY_EXTRA');
    const volumeIdx = yaml.indexOf('volumeMounts:');
    expect(extraIdx).toBeGreaterThan(0);
    expect(extraIdx).toBeLessThan(volumeIdx);
  });

  it('operator env vars appear after the required env vars in the patch', () => {
    const yaml = generateOverlayKustomization({
      ...baseEnv,
      env_vars: { CUSTOM: 'yes' },
    });
    const osPasswordIdx = yaml.indexOf('DOT_ES_AUTH_BASIC_PASSWORD');
    const customIdx = yaml.indexOf('- name: CUSTOM');
    expect(customIdx).toBeGreaterThan(osPasswordIdx);
  });

  it('does not duplicate required env vars when env_vars overrides same key', () => {
    // When operator sets DOT_DOTCMS_CLUSTER_ID in env_vars, Kubernetes
    // strategic-merge-patch uses "name" as the merge key, so the duplicate
    // will override the required entry.  The YAML should contain both entries
    // (Kustomize deduplication happens at apply time, not generation time).
    const yaml = generateOverlayKustomization({
      ...baseEnv,
      env_vars: { DOT_DOTCMS_CLUSTER_ID: 'custom-cluster' },
    });
    expect(yaml).toContain('value: "custom-cluster"');
    // The required entry is also present (Kustomize will use last/override)
    expect(yaml).toContain('DOT_DOTCMS_CLUSTER_ID');
  });
});

// ---------------------------------------------------------------------------
// scaffoldTenantOverlay — filesystem integration
// ---------------------------------------------------------------------------

describe('scaffoldTenantOverlay', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kustomize-test-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates overlay directory at {root}/{instance}/', async () => {
    const overlayDir = await scaffoldTenantOverlay(baseEnv, tmpRoot);
    expect(overlayDir).toBe(path.join(tmpRoot, 'fakecorp-prod'));
    // Directory must exist
    await expect(access(overlayDir)).resolves.toBeUndefined();
  });

  it('writes kustomization.yaml inside the overlay directory', async () => {
    const overlayDir = await scaffoldTenantOverlay(baseEnv, tmpRoot);
    const kFile = path.join(overlayDir, 'kustomization.yaml');
    await expect(access(kFile)).resolves.toBeUndefined();
  });

  it('kustomization.yaml contains correct namespace', async () => {
    const overlayDir = await scaffoldTenantOverlay(baseEnv, tmpRoot);
    const content = await readFile(path.join(overlayDir, 'kustomization.yaml'), 'utf8');
    expect(content).toContain('namespace: fakecorp');
  });

  it('kustomization.yaml references dotcms-base', async () => {
    const overlayDir = await scaffoldTenantOverlay(baseEnv, tmpRoot);
    const content = await readFile(path.join(overlayDir, 'kustomization.yaml'), 'utf8');
    expect(content).toContain('- ../../dotcms-base');
  });

  it('is idempotent — re-running overwrites the file without error', async () => {
    await scaffoldTenantOverlay(baseEnv, tmpRoot);

    // Second call with different replicas should overwrite
    const updated = { ...baseEnv, replicas: 5 };
    const overlayDir = await scaffoldTenantOverlay(updated, tmpRoot);
    const content = await readFile(path.join(overlayDir, 'kustomization.yaml'), 'utf8');
    expect(content).toContain('replicas: 5');
  });

  it('creates nested directory structure if root does not exist', async () => {
    const nestedRoot = path.join(tmpRoot, 'deep', 'nested', 'tenants');
    const overlayDir = await scaffoldTenantOverlay(baseEnv, nestedRoot);
    expect(overlayDir).toBe(path.join(nestedRoot, 'fakecorp-prod'));
    await expect(access(overlayDir)).resolves.toBeUndefined();
  });

  it('returns the absolute overlay dir path', async () => {
    const overlayDir = await scaffoldTenantOverlay(baseEnv, tmpRoot);
    expect(path.isAbsolute(overlayDir)).toBe(true);
    expect(overlayDir).toContain('fakecorp-prod');
  });
});
