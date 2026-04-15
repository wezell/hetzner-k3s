/**
 * bulkOps.test.ts — Unit tests for bulk environment operation utilities.
 *
 * Tests run in pure Node.js (no DOM required) since every function is a
 * pure computation over plain data.
 *
 * Coverage:
 *  - parseCompositeKey: key splitting, edge cases
 *  - formatBulkSummary: all-success, partial, all-failed messages
 *  - bulkResultAlertType: alert severity logic
 *  - bulkConfirmMessage: per-action confirmation copy
 */
import { describe, it, expect } from 'vitest';
import {
  parseCompositeKey,
  formatBulkSummary,
  bulkResultAlertType,
  bulkConfirmMessage,
  type BulkResult,
} from '@/lib/bulkOps';

// ── parseCompositeKey ─────────────────────────────────────────────────────────

describe('parseCompositeKey', () => {
  it('splits a simple orgKey/envKey pair', () => {
    const result = parseCompositeKey('acme/prod');
    expect(result.orgKey).toBe('acme');
    expect(result.envKey).toBe('prod');
  });

  it('handles env keys that themselves contain slashes', () => {
    // env_key should not contain slashes in practice, but the function
    // must not chop the env part at additional slashes
    const result = parseCompositeKey('acme/prod/v2');
    expect(result.orgKey).toBe('acme');
    expect(result.envKey).toBe('prod/v2');
  });

  it('handles hyphenated org and env keys', () => {
    const result = parseCompositeKey('my-org/my-env');
    expect(result.orgKey).toBe('my-org');
    expect(result.envKey).toBe('my-env');
  });

  it('handles underscore-delimited keys', () => {
    const result = parseCompositeKey('org_alpha/env_beta');
    expect(result.orgKey).toBe('org_alpha');
    expect(result.envKey).toBe('env_beta');
  });

  it('throws when no slash is present', () => {
    expect(() => parseCompositeKey('noSlashHere')).toThrow(/no slash/i);
  });

  it('handles leading slash (empty orgKey)', () => {
    const result = parseCompositeKey('/env-only');
    expect(result.orgKey).toBe('');
    expect(result.envKey).toBe('env-only');
  });
});

// ── formatBulkSummary ─────────────────────────────────────────────────────────

describe('formatBulkSummary', () => {
  it('shows only "succeeded" when failed is 0', () => {
    const result: BulkResult = { action: 'Redeploy', succeeded: 3, failed: 0 };
    expect(formatBulkSummary(result)).toBe('Redeploy: 3 succeeded');
  });

  it('shows both counts when there are failures', () => {
    const result: BulkResult = { action: 'Redeploy', succeeded: 2, failed: 1 };
    expect(formatBulkSummary(result)).toBe('Redeploy: 2 succeeded, 1 failed');
  });

  it('handles all-failed scenario (0 succeeded)', () => {
    const result: BulkResult = { action: 'Delete', succeeded: 0, failed: 4 };
    expect(formatBulkSummary(result)).toBe('Delete: 0 succeeded, 4 failed');
  });

  it('handles single environment operation', () => {
    const result: BulkResult = { action: 'Redeploy', succeeded: 1, failed: 0 };
    expect(formatBulkSummary(result)).toBe('Redeploy: 1 succeeded');
  });

  it('includes action name verbatim', () => {
    const result: BulkResult = { action: 'Custom Action', succeeded: 5, failed: 0 };
    expect(formatBulkSummary(result)).toContain('Custom Action');
  });

  it('produces a single string (not multiple items)', () => {
    const result: BulkResult = { action: 'Redeploy', succeeded: 10, failed: 2 };
    const summary = formatBulkSummary(result);
    // Must be a single string — constraints require no per-item toasts
    expect(typeof summary).toBe('string');
    expect(summary.split('\n').length).toBe(1);
  });
});

// ── bulkResultAlertType ───────────────────────────────────────────────────────

describe('bulkResultAlertType', () => {
  it('returns alert-success when all succeeded', () => {
    expect(bulkResultAlertType({ action: 'Redeploy', succeeded: 5, failed: 0 }))
      .toBe('alert-success');
  });

  it('returns alert-warning for partial failure', () => {
    expect(bulkResultAlertType({ action: 'Redeploy', succeeded: 3, failed: 2 }))
      .toBe('alert-warning');
  });

  it('returns alert-error when all failed', () => {
    expect(bulkResultAlertType({ action: 'Delete', succeeded: 0, failed: 4 }))
      .toBe('alert-error');
  });

  it('returns alert-success for a single successful operation', () => {
    expect(bulkResultAlertType({ action: 'Redeploy', succeeded: 1, failed: 0 }))
      .toBe('alert-success');
  });

  it('returns alert-error for a single failed operation', () => {
    expect(bulkResultAlertType({ action: 'Delete', succeeded: 0, failed: 1 }))
      .toBe('alert-error');
  });

  it('returns alert-warning for majority-success partial failure', () => {
    expect(bulkResultAlertType({ action: 'Redeploy', succeeded: 9, failed: 1 }))
      .toBe('alert-warning');
  });

  it('returns alert-warning for majority-failure partial failure', () => {
    expect(bulkResultAlertType({ action: 'Redeploy', succeeded: 1, failed: 9 }))
      .toBe('alert-warning');
  });
});

// ── bulkConfirmMessage ────────────────────────────────────────────────────────

describe('bulkConfirmMessage', () => {
  describe('redeploy action', () => {
    it('returns a title containing the count for single env', () => {
      const { title } = bulkConfirmMessage('redeploy', 1);
      expect(title).toContain('1');
      expect(title.toLowerCase()).toContain('redeploy');
    });

    it('returns singular "environment" for count of 1', () => {
      const { title } = bulkConfirmMessage('redeploy', 1);
      expect(title).toMatch(/environment[^s]/i);
    });

    it('returns plural "environments" for count > 1', () => {
      const { title } = bulkConfirmMessage('redeploy', 3);
      expect(title).toContain('environments');
    });

    it('body mentions re-provisioning', () => {
      const { body } = bulkConfirmMessage('redeploy', 2);
      expect(body.toLowerCase()).toMatch(/re-provisi|redeploy/i);
    });

    it('body is non-empty', () => {
      const { body } = bulkConfirmMessage('redeploy', 1);
      expect(body.length).toBeGreaterThan(10);
    });
  });

  describe('delete action', () => {
    it('returns a title containing the count', () => {
      const { title } = bulkConfirmMessage('delete', 5);
      expect(title).toContain('5');
    });

    it('body warns about irreversibility', () => {
      const { body } = bulkConfirmMessage('delete', 2);
      expect(body.toLowerCase()).toMatch(/cannot be undone|irreversible|permanent/i);
    });

    it('body mentions Kubernetes or infrastructure', () => {
      const { body } = bulkConfirmMessage('delete', 1);
      expect(body.toLowerCase()).toMatch(/kubernetes|namespace|database|s3/i);
    });

    it('singular title for count of 1', () => {
      const { title } = bulkConfirmMessage('delete', 1);
      expect(title).toMatch(/environment[^s]/i);
    });

    it('plural title for count > 1', () => {
      const { title } = bulkConfirmMessage('delete', 4);
      expect(title).toContain('environments');
    });
  });

  describe('both actions', () => {
    it('always returns an object with title and body', () => {
      for (const action of ['redeploy', 'delete'] as const) {
        const msg = bulkConfirmMessage(action, 2);
        expect(typeof msg.title).toBe('string');
        expect(typeof msg.body).toBe('string');
        expect(msg.title.length).toBeGreaterThan(0);
        expect(msg.body.length).toBeGreaterThan(0);
      }
    });
  });
});

// ── Integration: composite key → parsed → operation result ───────────────────

describe('bulk operation flow integration', () => {
  it('can parse multiple keys and produce a result summary', () => {
    const selectedKeys = new Set([
      'acme/prod',
      'acme/staging',
      'beta/main',
    ]);

    // Simulate what handleBulkRedeploy does
    const keys = [...selectedKeys];
    const parsed = keys.map(parseCompositeKey);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ orgKey: 'acme', envKey: 'prod' });
    expect(parsed[1]).toEqual({ orgKey: 'acme', envKey: 'staging' });
    expect(parsed[2]).toEqual({ orgKey: 'beta', envKey: 'main' });

    // Simulate 2 succeed, 1 fail
    const result: BulkResult = { action: 'Redeploy', succeeded: 2, failed: 1 };
    expect(formatBulkSummary(result)).toBe('Redeploy: 2 succeeded, 1 failed');
    expect(bulkResultAlertType(result)).toBe('alert-warning');
  });

  it('all-success flow produces a green toast message', () => {
    const result: BulkResult = { action: 'Redeploy', succeeded: 3, failed: 0 };
    expect(bulkResultAlertType(result)).toBe('alert-success');
    expect(formatBulkSummary(result)).not.toContain('failed');
  });

  it('all-failure flow produces a red toast message', () => {
    const result: BulkResult = { action: 'Delete', succeeded: 0, failed: 3 };
    expect(bulkResultAlertType(result)).toBe('alert-error');
    expect(formatBulkSummary(result)).toContain('failed');
  });

  it('confirmation copy is available before execution begins', () => {
    // The modal must be populated before the operation starts
    const { title, body } = bulkConfirmMessage('redeploy', 5);
    expect(title).toBeTruthy();
    expect(body).toBeTruthy();
    // Confirm copy does not depend on operation result
    expect(title).not.toContain('failed');
    expect(title).not.toContain('succeeded');
  });
});
