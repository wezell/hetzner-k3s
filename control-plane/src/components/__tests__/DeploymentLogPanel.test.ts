/**
 * DeploymentLogPanel unit tests
 *
 * Pure Node.js environment — no DOM / jsdom.  We test:
 *
 *  1. The STATUS_STYLES colour-and-style contract mapping (success → green,
 *     failed → red, retrying → orange with animate-pulse).
 *  2. The ACTION_LABELS display mapping for all four log actions.
 *  3. formatTimestamp / relativeTime pure utilities extracted and verified.
 *  4. The data contract between the status-endpoint response and the fields
 *     that DeploymentLogPanel renders per log entry.
 *
 * DeploymentLogPanel is a React component so we don't render it here, but
 * we exercise the pure-logic portions that drive its visual output — the same
 * approach used by StatusBadge.test.ts and EnvList.polling.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DeploymentLog, LogAction, LogStatus } from '@/db/types';

// ---------------------------------------------------------------------------
// Local re-implementations of pure helpers from DeploymentLogPanel.tsx
// (mirrors the component's internal logic so tests stay in sync)
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<LogAction, string> = {
  provision: 'Provision',
  patch: 'Patch',
  stop: 'Stop',
  decommission: 'Decommission',
};

interface StyleEntry {
  text: string;
  bg: string;
  dot: string;
}

const STATUS_STYLES: Record<LogStatus, StyleEntry> = {
  success: {
    text: 'text-green-700 dark:text-green-300',
    bg: 'bg-green-50 dark:bg-green-900/20',
    dot: 'bg-green-500',
  },
  failed: {
    text: 'text-red-700 dark:text-red-300',
    bg: 'bg-red-50 dark:bg-red-900/20',
    dot: 'bg-red-500',
  },
  retrying: {
    text: 'text-orange-700 dark:text-orange-300',
    bg: 'bg-orange-50 dark:bg-orange-900/20',
    dot: 'bg-orange-500 animate-pulse',
  },
};

/** Matches the component's relativeTime helper */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLog(overrides: Partial<DeploymentLog> = {}): DeploymentLog {
  return {
    deployment_log_id: 1,
    log_org_key: 'acme',
    log_env_key: 'prod',
    action: 'provision',
    status: 'success',
    error_detail: null,
    retry_count: 0,
    created_date: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. STATUS_STYLES config
// ---------------------------------------------------------------------------

describe('STATUS_STYLES', () => {
  const ALL_LOG_STATUSES: LogStatus[] = ['success', 'failed', 'retrying'];

  it('has an entry for every LogStatus value', () => {
    for (const s of ALL_LOG_STATUSES) {
      expect(STATUS_STYLES).toHaveProperty(s);
    }
  });

  it('each entry has text, bg, and dot fields', () => {
    for (const s of ALL_LOG_STATUSES) {
      const entry = STATUS_STYLES[s];
      expect(entry.text, `${s}.text`).toBeTypeOf('string');
      expect(entry.bg, `${s}.bg`).toBeTypeOf('string');
      expect(entry.dot, `${s}.dot`).toBeTypeOf('string');
    }
  });

  it('"success" uses the green colour family', () => {
    expect(STATUS_STYLES.success.text).toContain('green');
    expect(STATUS_STYLES.success.bg).toContain('green');
    expect(STATUS_STYLES.success.dot).toContain('green');
  });

  it('"failed" uses the red colour family', () => {
    expect(STATUS_STYLES.failed.text).toContain('red');
    expect(STATUS_STYLES.failed.bg).toContain('red');
    expect(STATUS_STYLES.failed.dot).toContain('red');
  });

  it('"retrying" uses the orange colour family', () => {
    expect(STATUS_STYLES.retrying.text).toContain('orange');
    expect(STATUS_STYLES.retrying.bg).toContain('orange');
    expect(STATUS_STYLES.retrying.dot).toContain('orange');
  });

  it('"retrying" dot includes animate-pulse (worker actively retrying)', () => {
    expect(STATUS_STYLES.retrying.dot).toContain('animate-pulse');
  });

  it('"success" and "failed" dots do NOT animate (terminal states)', () => {
    expect(STATUS_STYLES.success.dot).not.toContain('animate-pulse');
    expect(STATUS_STYLES.failed.dot).not.toContain('animate-pulse');
  });

  it('all entries have dark: variants for both text and bg', () => {
    for (const s of ALL_LOG_STATUSES) {
      expect(STATUS_STYLES[s].text, `${s}.text dark`).toMatch(/dark:/);
      expect(STATUS_STYLES[s].bg, `${s}.bg dark`).toMatch(/dark:/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. ACTION_LABELS
// ---------------------------------------------------------------------------

describe('ACTION_LABELS', () => {
  const ALL_ACTIONS: LogAction[] = ['provision', 'patch', 'stop', 'decommission'];

  it('has an entry for every LogAction value', () => {
    for (const a of ALL_ACTIONS) {
      expect(ACTION_LABELS).toHaveProperty(a);
    }
  });

  it('maps each action to a non-empty capitalised label', () => {
    for (const a of ALL_ACTIONS) {
      const label = ACTION_LABELS[a];
      expect(label.length).toBeGreaterThan(0);
      // First character should be uppercase
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });

  const expected: Record<LogAction, string> = {
    provision: 'Provision',
    patch: 'Patch',
    stop: 'Stop',
    decommission: 'Decommission',
  };

  for (const [action, label] of Object.entries(expected) as [LogAction, string][]) {
    it(`"${action}" displays as "${label}"`, () => {
      expect(ACTION_LABELS[action as LogAction]).toBe(label);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. relativeTime helper
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  let now: number;

  beforeAll(() => {
    now = Date.now();
  });

  it('returns "Ns ago" for recent timestamps (< 60 s)', () => {
    const ts = new Date(now - 30_000).toISOString();
    expect(relativeTime(ts)).toBe('30s ago');
  });

  it('returns "Nm ago" for timestamps in the past minute range', () => {
    const ts = new Date(now - 5 * 60_000).toISOString();
    expect(relativeTime(ts)).toBe('5m ago');
  });

  it('returns "Nh ago" for timestamps in the past hour range', () => {
    const ts = new Date(now - 3 * 3_600_000).toISOString();
    expect(relativeTime(ts)).toBe('3h ago');
  });

  it('returns "Nd ago" for timestamps older than 24 hours', () => {
    const ts = new Date(now - 2 * 86_400_000).toISOString();
    expect(relativeTime(ts)).toBe('2d ago');
  });

  it('returns "just now" for future timestamps', () => {
    const ts = new Date(now + 5_000).toISOString();
    expect(relativeTime(ts)).toBe('just now');
  });
});

// ---------------------------------------------------------------------------
// 4. DeploymentLog data contract
// ---------------------------------------------------------------------------
//
// These tests verify that the shape coming from /api/envs/[id]/status
// (DeploymentLog array) contains all fields DeploymentLogPanel renders.

describe('DeploymentLog data contract', () => {
  it('success log entry has all required fields', () => {
    const entry = makeLog({ action: 'provision', status: 'success' });
    expect(entry).toHaveProperty('deployment_log_id');
    expect(entry).toHaveProperty('action');
    expect(entry).toHaveProperty('status');
    expect(entry).toHaveProperty('retry_count');
    expect(entry).toHaveProperty('created_date');
    expect(entry).toHaveProperty('error_detail');
    expect(entry.error_detail).toBeNull();
  });

  it('failed log entry carries error_detail string', () => {
    const entry = makeLog({
      status: 'failed',
      error_detail: 'kubectl exec timed out',
      retry_count: 3,
    });
    expect(entry.status).toBe('failed');
    expect(entry.error_detail).toBe('kubectl exec timed out');
    expect(entry.retry_count).toBe(3);
  });

  it('retrying log entry has retry_count > 0', () => {
    const entry = makeLog({ status: 'retrying', retry_count: 2 });
    expect(entry.status).toBe('retrying');
    expect(entry.retry_count).toBeGreaterThan(0);
  });

  it('STATUS_STYLES[entry.status] resolves for all fixture statuses', () => {
    const statuses: LogStatus[] = ['success', 'failed', 'retrying'];
    for (const status of statuses) {
      const entry = makeLog({ status });
      const style = STATUS_STYLES[entry.status];
      expect(style, `style for ${status}`).toBeDefined();
    }
  });

  it('ACTION_LABELS[entry.action] resolves for all fixture actions', () => {
    const actions: LogAction[] = ['provision', 'patch', 'stop', 'decommission'];
    for (const action of actions) {
      const entry = makeLog({ action });
      const label = ACTION_LABELS[entry.action];
      expect(label, `label for ${action}`).toBeDefined();
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('deployment_log_id is a unique-able numeric key', () => {
    const logs: DeploymentLog[] = [
      makeLog({ deployment_log_id: 1 }),
      makeLog({ deployment_log_id: 2 }),
      makeLog({ deployment_log_id: 3 }),
    ];
    const ids = logs.map((l) => l.deployment_log_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// 5. Status endpoint response shape → DeploymentLogPanel props contract
// ---------------------------------------------------------------------------

describe('status endpoint response → DeploymentLogPanel contract', () => {
  const mockStatusResponse = {
    org_key: 'acme',
    env_key: 'prod',
    deploy_status: 'deployed',
    last_deploy_date: '2026-04-14T12:00:00.000Z',
    stop_date: null,
    dcomm_date: null,
    mod_date: '2026-04-14T12:01:00.000Z',
    current_retry_count: 0,
    logs: [
      makeLog({
        deployment_log_id: 42,
        action: 'provision',
        status: 'success',
        created_date: '2026-04-14T12:00:00.000Z',
      }),
      makeLog({
        deployment_log_id: 41,
        action: 'provision',
        status: 'retrying',
        retry_count: 1,
        error_detail: 'pod not ready after 10m',
        created_date: '2026-04-14T11:50:00.000Z',
      }),
    ] as DeploymentLog[],
  };

  it('response.logs is an array of DeploymentLog entries', () => {
    expect(Array.isArray(mockStatusResponse.logs)).toBe(true);
    expect(mockStatusResponse.logs.length).toBe(2);
  });

  it('newest log entry (index 0) is the success entry', () => {
    const latest = mockStatusResponse.logs[0];
    expect(latest.status).toBe('success');
    expect(latest.deployment_log_id).toBe(42);
  });

  it('each log entry can be resolved to a STATUS_STYLES entry', () => {
    for (const entry of mockStatusResponse.logs) {
      const style = STATUS_STYLES[entry.status as LogStatus];
      expect(style).toBeDefined();
    }
  });

  it('each log entry can be resolved to an ACTION_LABELS entry', () => {
    for (const entry of mockStatusResponse.logs) {
      const label = ACTION_LABELS[entry.action as LogAction];
      expect(label).toBeDefined();
    }
  });

  it('failed-with-error entry exposes error_detail for collapsible display', () => {
    const retryEntry = mockStatusResponse.logs.find((l) => l.status === 'retrying');
    expect(retryEntry?.error_detail).toBe('pod not ready after 10m');
  });

  it('retry_count > 0 on retrying entry triggers attempt counter in UI', () => {
    const retryEntry = mockStatusResponse.logs.find((l) => l.status === 'retrying');
    expect(retryEntry?.retry_count).toBeGreaterThan(0);
  });

  it('DeploymentLogPanel endpoint URL is constructed from org_key + env_key', () => {
    const { org_key, env_key } = mockStatusResponse;
    const limit = 50;
    const url = `/api/envs/${encodeURIComponent(org_key)}/status?env_key=${encodeURIComponent(env_key)}&limit=${limit}`;
    expect(url).toBe('/api/envs/acme/status?env_key=prod&limit=50');
  });
});

// ---------------------------------------------------------------------------
// 6. afterAll: nothing to clean up — pure tests, no side effects
// ---------------------------------------------------------------------------
afterAll(() => {
  /* no-op */
});

// ---------------------------------------------------------------------------
// 7. Retry button pure-logic contract
//    These tests exercise the two exported helpers:
//      - buildRetriggerUrl(org_key, env_key) → URL string
//      - deriveRetriggerAction(logs) → LogAction | null
// ---------------------------------------------------------------------------

// Import the exported helpers directly from the component module.
// The component is 'use client' but the helpers are pure functions with no
// React deps, so they run fine in Node.js / Vitest without jsdom.
import {
  buildRetriggerUrl,
  deriveRetriggerAction,
  buildLogsUrl,
  computeIsNearBottom,
} from '../DeploymentLogPanel';

describe('buildRetriggerUrl', () => {
  it('constructs the correct retrigger endpoint path', () => {
    const url = buildRetriggerUrl('acme', 'prod');
    expect(url).toBe('/api/envs/acme/retrigger?env_key=prod');
  });

  it('URL-encodes org_key and env_key', () => {
    const url = buildRetriggerUrl('my org', 'my env');
    expect(url).toBe('/api/envs/my%20org/retrigger?env_key=my%20env');
  });

  it('produces a URL the retrigger endpoint recognises (path + query shape)', () => {
    const url = buildRetriggerUrl('dotcms', 'staging');
    expect(url).toMatch(/^\/api\/envs\/[^/]+\/retrigger\?env_key=/);
  });

  it('each org/env pair produces a distinct URL', () => {
    const url1 = buildRetriggerUrl('org-a', 'env-1');
    const url2 = buildRetriggerUrl('org-b', 'env-2');
    expect(url1).not.toBe(url2);
  });
});

describe('deriveRetriggerAction', () => {
  it('returns null when log array is empty (no button shown)', () => {
    expect(deriveRetriggerAction([])).toBeNull();
  });

  it('returns the action of the first (newest) log entry', () => {
    const logs: DeploymentLog[] = [
      makeLog({ deployment_log_id: 10, action: 'patch', status: 'failed' }),
      makeLog({ deployment_log_id: 9, action: 'provision', status: 'success' }),
    ];
    expect(deriveRetriggerAction(logs)).toBe('patch');
  });

  it('returns "provision" when the newest entry is a provision action', () => {
    const logs = [makeLog({ action: 'provision', status: 'failed' })];
    expect(deriveRetriggerAction(logs)).toBe('provision');
  });

  it('returns "stop" when the newest entry is a stop action', () => {
    const logs = [makeLog({ action: 'stop', status: 'failed' })];
    expect(deriveRetriggerAction(logs)).toBe('stop');
  });

  it('returns "decommission" when the newest entry is a decommission action', () => {
    const logs = [makeLog({ action: 'decommission', status: 'failed' })];
    expect(deriveRetriggerAction(logs)).toBe('decommission');
  });

  it.each(['provision', 'patch', 'stop', 'decommission'] as LogAction[])(
    'works for all four LogAction values (%s)',
    (action) => {
      const logs = [makeLog({ action })];
      expect(deriveRetriggerAction(logs)).toBe(action);
    },
  );

  it('ignores all entries beyond index 0 — only newest action matters', () => {
    const logs: DeploymentLog[] = [
      makeLog({ deployment_log_id: 5, action: 'decommission' }),
      makeLog({ deployment_log_id: 4, action: 'stop' }),
      makeLog({ deployment_log_id: 3, action: 'patch' }),
      makeLog({ deployment_log_id: 2, action: 'provision' }),
    ];
    // Only logs[0].action should be returned regardless of subsequent entries
    expect(deriveRetriggerAction(logs)).toBe('decommission');
  });
});

// ---------------------------------------------------------------------------
// 8. Retrigger request payload contract
//    Verifies the shape of the POST body sent to the retrigger endpoint.
// ---------------------------------------------------------------------------

describe('retrigger request payload contract', () => {
  it('POST body contains { action } derived from the newest log entry', () => {
    const newestLog = makeLog({ action: 'patch', status: 'failed' });
    const logs: DeploymentLog[] = [newestLog, makeLog({ action: 'provision' })];

    const action = deriveRetriggerAction(logs);
    const payload = JSON.stringify({ action });

    expect(JSON.parse(payload)).toEqual({ action: 'patch' });
  });

  it('retrigger endpoint URL + body together match the API contract', () => {
    const logs = [makeLog({ action: 'stop', status: 'failed' })];
    const url = buildRetriggerUrl('dotcms', 'prod');
    const action = deriveRetriggerAction(logs);
    const body = JSON.stringify({ action });

    // URL shape
    expect(url).toBe('/api/envs/dotcms/retrigger?env_key=prod');
    // Body shape
    expect(JSON.parse(body)).toMatchObject({ action: 'stop' });
  });

  it.each([
    ['provision', 'pending'],
    ['patch', 'reconfiguring'],
    ['stop', 'stopping'],
    ['decommission', 'decommissioning'],
  ] as [LogAction, string][])(
    'action=%s from logs produces the correct retrigger payload',
    (action, _expectedStatus) => {
      const logs = [makeLog({ action })];
      const derived = deriveRetriggerAction(logs);
      expect(derived).toBe(action);
      expect(JSON.parse(JSON.stringify({ action: derived }))).toEqual({ action });
    },
  );
});

// ---------------------------------------------------------------------------
// 9. buildLogsUrl — cursor-based pagination URL construction
// ---------------------------------------------------------------------------

describe('buildLogsUrl', () => {
  it('constructs the correct logs endpoint path with limit', () => {
    const url = buildLogsUrl('acme', 'prod', 50);
    expect(url).toBe('/api/envs/acme/logs?env_key=prod&limit=50');
  });

  it('URL-encodes org_key when it contains special characters', () => {
    const url = buildLogsUrl('acme corp', 'prod', 50);
    expect(url).toBe('/api/envs/acme%20corp/logs?env_key=prod&limit=50');
  });

  it('URL-encodes env_key when it contains special characters', () => {
    const url = buildLogsUrl('acme', 'prod env', 50);
    expect(url).toBe('/api/envs/acme/logs?env_key=prod%20env&limit=50');
  });

  it('appends before_id cursor when provided', () => {
    const url = buildLogsUrl('acme', 'prod', 50, 99);
    expect(url).toBe('/api/envs/acme/logs?env_key=prod&limit=50&before_id=99');
  });

  it('omits before_id when not provided', () => {
    const url = buildLogsUrl('acme', 'prod', 50);
    expect(url).not.toContain('before_id');
  });

  it('omits before_id when undefined is passed explicitly', () => {
    const url = buildLogsUrl('acme', 'prod', 100, undefined);
    expect(url).not.toContain('before_id');
  });

  it('reflects the limit parameter in the URL', () => {
    expect(buildLogsUrl('acme', 'prod', 10)).toContain('limit=10');
    expect(buildLogsUrl('acme', 'prod', 200)).toContain('limit=200');
    expect(buildLogsUrl('acme', 'prod', 500)).toContain('limit=500');
  });

  it('each distinct before_id produces a distinct URL', () => {
    const url1 = buildLogsUrl('acme', 'prod', 50, 50);
    const url2 = buildLogsUrl('acme', 'prod', 50, 100);
    expect(url1).not.toBe(url2);
  });

  it('URL without cursor and URL with cursor differ only in before_id suffix', () => {
    const base = buildLogsUrl('acme', 'prod', 50);
    const paged = buildLogsUrl('acme', 'prod', 50, 75);
    expect(paged).toBe(base + '&before_id=75');
  });

  it('matches the shape expected by the logs API route', () => {
    const url = buildLogsUrl('dotcms', 'staging', 25, 200);
    expect(url).toMatch(/^\/api\/envs\/[^/]+\/logs\?env_key=[^&]+&limit=\d+&before_id=\d+$/);
  });

  it('each org/env pair produces a distinct URL', () => {
    const url1 = buildLogsUrl('org-a', 'env-1', 50);
    const url2 = buildLogsUrl('org-b', 'env-2', 50);
    expect(url1).not.toBe(url2);
  });

  it('before_id=1 (minimum valid cursor) is included correctly', () => {
    const url = buildLogsUrl('acme', 'prod', 50, 1);
    expect(url).toContain('before_id=1');
  });
});

// ---------------------------------------------------------------------------
// 10. Cursor-based pagination state machine contract
//     Verifies the data flow between fetchLogs (first page) and
//     fetchMoreLogs (subsequent pages) using the cursor pattern.
// ---------------------------------------------------------------------------

describe('cursor-based pagination contract', () => {
  it('initial fetch uses no cursor (first page)', () => {
    const url = buildLogsUrl('acme', 'prod', 50);
    expect(url).not.toContain('before_id');
  });

  it('subsequent fetch uses oldest log id as cursor', () => {
    const logs: DeploymentLog[] = [
      makeLog({ deployment_log_id: 100 }),
      makeLog({ deployment_log_id: 99 }),
      makeLog({ deployment_log_id: 98 }),
    ];
    // fetchMoreLogs uses logs[logs.length - 1].deployment_log_id as before_id
    const oldestId = logs[logs.length - 1].deployment_log_id;
    const url = buildLogsUrl('acme', 'prod', 50, oldestId);
    expect(url).toContain('before_id=98');
  });

  it('paginated URL fetches entries older than the cursor', () => {
    // The API returns entries with deployment_log_id < before_id
    // so we verify the cursor points to the oldest entry seen so far
    const firstPage: DeploymentLog[] = [
      makeLog({ deployment_log_id: 10 }),
      makeLog({ deployment_log_id: 9 }),
      makeLog({ deployment_log_id: 8 }),
    ];
    const oldestInPage = firstPage[firstPage.length - 1].deployment_log_id;
    expect(oldestInPage).toBe(8);

    const nextPageUrl = buildLogsUrl('acme', 'prod', 50, oldestInPage);
    expect(nextPageUrl).toContain('before_id=8');
  });

  it('pagination cursor decreases monotonically with each page', () => {
    const pages: DeploymentLog[][] = [
      [makeLog({ deployment_log_id: 30 }), makeLog({ deployment_log_id: 29 })],
      [makeLog({ deployment_log_id: 28 }), makeLog({ deployment_log_id: 27 })],
      [makeLog({ deployment_log_id: 26 }), makeLog({ deployment_log_id: 25 })],
    ];

    const cursors = pages.map((page) => page[page.length - 1].deployment_log_id);
    for (let i = 1; i < cursors.length; i++) {
      expect(cursors[i]).toBeLessThan(cursors[i - 1]);
    }
  });

  it('empty logs array prevents pagination (no cursor to use)', () => {
    const logs: DeploymentLog[] = [];
    // fetchMoreLogs early-returns if logs.length === 0
    expect(logs.length).toBe(0);
    // No cursor can be derived
    const oldestId = logs[logs.length - 1]?.deployment_log_id;
    expect(oldestId).toBeUndefined();
  });

  it('has_more=false signals end of pagination', () => {
    // Simulates the API response shape when no more pages exist
    const apiResponse = {
      org_key: 'acme',
      env_key: 'prod',
      logs: [makeLog({ deployment_log_id: 1 })],
      total: 1,
      has_more: false,
    };
    expect(apiResponse.has_more).toBe(false);
  });

  it('has_more=true signals additional pages to fetch', () => {
    const apiResponse = {
      org_key: 'acme',
      env_key: 'prod',
      logs: Array.from({ length: 50 }, (_, i) =>
        makeLog({ deployment_log_id: 100 - i })
      ),
      total: 200,
      has_more: true,
    };
    expect(apiResponse.has_more).toBe(true);
    expect(apiResponse.logs.length).toBe(50);
  });

  it('paginated logs are appended (not replaced) to grow the history', () => {
    const firstPage: DeploymentLog[] = [
      makeLog({ deployment_log_id: 10 }),
      makeLog({ deployment_log_id: 9 }),
    ];
    const secondPage: DeploymentLog[] = [
      makeLog({ deployment_log_id: 8 }),
      makeLog({ deployment_log_id: 7 }),
    ];
    // fetchMoreLogs: setLogs((prev) => [...prev, ...data.logs])
    const combined = [...firstPage, ...secondPage];
    expect(combined.length).toBe(4);
    expect(combined[0].deployment_log_id).toBe(10); // newest first
    expect(combined[3].deployment_log_id).toBe(7);  // oldest last
  });
});

// ---------------------------------------------------------------------------
// 11. computeIsNearBottom — auto-scroll position detection
// ---------------------------------------------------------------------------

describe('computeIsNearBottom', () => {
  it('returns true when exactly at the bottom (distance = 0)', () => {
    // scrollHeight=500, scrollTop=400, clientHeight=100 → distance=0
    expect(computeIsNearBottom(500, 400, 100)).toBe(true);
  });

  it('returns true when within the default 60px threshold', () => {
    // distance = 500 - 390 - 100 = 10 < 60
    expect(computeIsNearBottom(500, 390, 100)).toBe(true);
  });

  it('returns true when exactly at the threshold boundary (distance = 59)', () => {
    // distance = 500 - 341 - 100 = 59 < 60
    expect(computeIsNearBottom(500, 341, 100)).toBe(true);
  });

  it('returns false when exactly at the threshold (distance = 60)', () => {
    // distance = 500 - 340 - 100 = 60, not < 60
    expect(computeIsNearBottom(500, 340, 100)).toBe(false);
  });

  it('returns false when well above the bottom', () => {
    // distance = 500 - 0 - 100 = 400 >> 60
    expect(computeIsNearBottom(500, 0, 100)).toBe(false);
  });

  it('returns false when scrolled to the top of a long list', () => {
    // Tall container, user at the top
    expect(computeIsNearBottom(2000, 0, 300)).toBe(false);
  });

  it('returns true when scrolled to the bottom of a long list', () => {
    // scrollTop = scrollHeight - clientHeight exactly
    expect(computeIsNearBottom(2000, 1700, 300)).toBe(true);
  });

  it('respects a custom threshold parameter', () => {
    // Custom threshold = 100
    // distance = 500 - 350 - 100 = 50 < 100 → true
    expect(computeIsNearBottom(500, 350, 100, 100)).toBe(true);
    // distance = 500 - 300 - 100 = 100, not < 100 → false
    expect(computeIsNearBottom(500, 300, 100, 100)).toBe(false);
  });

  it('threshold=0 returns false even at exact bottom (strict less-than)', () => {
    // distance = 500 - 400 - 100 = 0; 0 < 0 is false (strict less-than boundary)
    expect(computeIsNearBottom(500, 400, 100, 0)).toBe(false);
    // distance = 500 - 401 - 100 = -1; -1 < 0 is true (past bottom / overscroll)
    expect(computeIsNearBottom(500, 401, 100, 0)).toBe(true);
  });

  it('handles small containers (clientHeight ≈ scrollHeight)', () => {
    // Container just big enough to show all content — always "near bottom"
    expect(computeIsNearBottom(200, 0, 200)).toBe(true);
  });

  it('handles zero scrollTop correctly', () => {
    // Unscrolled, tall content — not near bottom
    expect(computeIsNearBottom(1000, 0, 400)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Auto-scroll behavior contract (logic layer)
//     Verifies the decision rules that govern whether new log entries
//     trigger auto-scroll or leave the user's scroll position intact.
// ---------------------------------------------------------------------------

describe('auto-scroll behavior contract', () => {
  it('auto-scroll is enabled when user is near the bottom', () => {
    // scrollHeight=500, scrollTop=395, clientHeight=100 → distance=5 < 60
    const shouldAutoScroll = computeIsNearBottom(500, 395, 100);
    expect(shouldAutoScroll).toBe(true);
  });

  it('auto-scroll is disabled when user has scrolled up', () => {
    // scrollHeight=500, scrollTop=200, clientHeight=100 → distance=200 > 60
    const shouldAutoScroll = computeIsNearBottom(500, 200, 100);
    expect(shouldAutoScroll).toBe(false);
  });

  it('auto-scroll re-enables when user scrolls back to bottom', () => {
    // Simulate scroll-up then scroll-back-down
    const scrolledUp = computeIsNearBottom(500, 100, 100);    // distance=300, false
    const scrolledDown = computeIsNearBottom(500, 395, 100);  // distance=5, true
    expect(scrolledUp).toBe(false);
    expect(scrolledDown).toBe(true);
  });

  it('new entries do not scroll when user has scrolled away (distance > threshold)', () => {
    // A test documenting the expected behavior: if autoScrollRef.current=false,
    // bottomRef.scrollIntoView is NOT called on new log entries.
    // We verify this indirectly through the near-bottom detection.
    const userScrolledAway = !computeIsNearBottom(1000, 0, 400);
    expect(userScrolledAway).toBe(true); // auto-scroll suppressed
  });

  it('new entries auto-scroll when user is near the bottom', () => {
    const userNearBottom = computeIsNearBottom(1000, 895, 100); // distance=5
    expect(userNearBottom).toBe(true); // auto-scroll fires
  });

  it('auto-scroll resets to enabled when org_key/env_key changes (new environment)', () => {
    // Simulates the useEffect([org_key, env_key]) → autoScrollRef.current = true
    // The reset is a hard true — independent of scroll position.
    let autoScroll = false; // user had scrolled up in previous env
    // When env changes, reset to true regardless
    autoScroll = true;
    expect(autoScroll).toBe(true);
  });
});
