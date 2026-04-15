/**
 * dateFormat.ts — unit tests
 *
 * Verifies the date formatting utilities used for dcomm_date and other
 * timestamp fields on the environment detail page.
 *
 * No DOM, no React. Pure Node.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDate, formatRelativeTime } from '@/lib/dateFormat';

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe('formatDate', () => {
  it('returns "—" for null', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(formatDate(undefined)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(formatDate('')).toBe('—');
  });

  it('returns a non-empty string for a valid ISO timestamp', () => {
    const result = formatDate('2026-04-14T12:00:00.000Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('—');
  });

  it('includes the year from the given timestamp', () => {
    const result = formatDate('2026-04-14T12:00:00.000Z');
    expect(result).toContain('2026');
  });

  it('handles a timestamp string without milliseconds', () => {
    const result = formatDate('2026-04-14T00:00:00Z');
    expect(result).not.toBe('—');
    expect(result).toContain('2026');
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  const FAKE_NOW = new Date('2026-04-14T20:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Null / empty cases
  it('returns "—" for null', () => {
    expect(formatRelativeTime(null)).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(formatRelativeTime('')).toBe('—');
  });

  // "just now" — less than 60 seconds ago
  it('returns "just now" for a timestamp 30 seconds in the past', () => {
    const ts = new Date(FAKE_NOW - 30_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('just now');
  });

  it('returns "just now" for a timestamp 30 seconds in the future', () => {
    const ts = new Date(FAKE_NOW + 30_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('just now');
  });

  // Minutes — 60 s to 3600 s
  it('returns "Nm ago" for a timestamp N minutes in the past', () => {
    const ts = new Date(FAKE_NOW - 5 * 60_000).toISOString(); // 5 minutes ago
    expect(formatRelativeTime(ts)).toBe('5m ago');
  });

  it('returns "1m ago" for a timestamp 90 seconds ago', () => {
    const ts = new Date(FAKE_NOW - 90_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('1m ago');
  });

  it('returns "59m ago" for a timestamp 59 minutes ago', () => {
    const ts = new Date(FAKE_NOW - 59 * 60_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('59m ago');
  });

  // Hours — 3600 s to 86400 s
  it('returns "Nh ago" for a timestamp N hours in the past', () => {
    const ts = new Date(FAKE_NOW - 3 * 3_600_000).toISOString(); // 3 hours ago
    expect(formatRelativeTime(ts)).toBe('3h ago');
  });

  it('returns "1h ago" for a timestamp exactly 1 hour ago', () => {
    const ts = new Date(FAKE_NOW - 3_600_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('1h ago');
  });

  it('returns "23h ago" for a timestamp 23 hours ago', () => {
    const ts = new Date(FAKE_NOW - 23 * 3_600_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('23h ago');
  });

  // Days — 86400 s to 30 * 86400 s
  it('returns "Nd ago" for a timestamp N days in the past', () => {
    const ts = new Date(FAKE_NOW - 7 * 86_400_000).toISOString(); // 7 days ago
    expect(formatRelativeTime(ts)).toBe('7d ago');
  });

  it('returns "1d ago" for a timestamp exactly 1 day ago', () => {
    const ts = new Date(FAKE_NOW - 86_400_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('1d ago');
  });

  it('returns "29d ago" for a timestamp 29 days ago', () => {
    const ts = new Date(FAKE_NOW - 29 * 86_400_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('29d ago');
  });

  // Older than 30 days → falls back to formatDate
  it('falls back to formatted date for timestamps older than 30 days', () => {
    const ts = new Date(FAKE_NOW - 31 * 86_400_000).toISOString();
    const result = formatRelativeTime(ts);
    // Should not match any relative pattern
    expect(result).not.toMatch(/\d+(m|h|d) ago/);
    expect(result).not.toBe('just now');
    expect(result).not.toBe('—');
    // Must contain a year
    expect(result).toMatch(/\d{4}/);
  });

  // Future timestamps (e.g. scheduled dcomm_date)
  it('returns "Nm ago" for a future dcomm_date 5 minutes from now', () => {
    const ts = new Date(FAKE_NOW + 5 * 60_000).toISOString();
    // abs diff is 5 minutes → "5m ago"
    expect(formatRelativeTime(ts)).toBe('5m ago');
  });

  it('returns "2h ago" for a future dcomm_date 2 hours from now', () => {
    const ts = new Date(FAKE_NOW + 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(ts)).toBe('2h ago');
  });
});

// ---------------------------------------------------------------------------
// dcomm_date display logic (conditional rendering guard)
//
// The detail page renders the "Decommission scheduled" InfoRow only when
// (status?.dcomm_date ?? envData.dcomm_date) is truthy.
// These tests document that contract without requiring React rendering.
// ---------------------------------------------------------------------------

describe('dcomm_date conditional visibility contract', () => {
  type StatusSnapshot = { dcomm_date: string | null } | null;
  type EnvData = { dcomm_date: string | null };

  /**
   * Mirrors the JSX guard: `(status?.dcomm_date ?? envData.dcomm_date)`
   */
  function resolvedDcommDate(
    status: StatusSnapshot,
    envData: EnvData
  ): string | null {
    return status?.dcomm_date ?? envData.dcomm_date;
  }

  it('is null when both status and envData have null dcomm_date', () => {
    expect(resolvedDcommDate(null, { dcomm_date: null })).toBeNull();
  });

  it('is null when status is null and envData.dcomm_date is null', () => {
    expect(resolvedDcommDate(null, { dcomm_date: null })).toBeNull();
  });

  it('uses envData.dcomm_date when status is null', () => {
    const ts = '2026-04-14T13:00:00.000Z';
    expect(resolvedDcommDate(null, { dcomm_date: ts })).toBe(ts);
  });

  it('uses status.dcomm_date when status is present', () => {
    const ts = '2026-04-14T13:00:00.000Z';
    expect(
      resolvedDcommDate({ dcomm_date: ts }, { dcomm_date: null })
    ).toBe(ts);
  });

  it('status.dcomm_date takes precedence over envData.dcomm_date', () => {
    const statusTs = '2026-04-14T13:00:00.000Z';
    const envTs = '2026-04-14T12:00:00.000Z';
    expect(
      resolvedDcommDate({ dcomm_date: statusTs }, { dcomm_date: envTs })
    ).toBe(statusTs);
  });

  it('falls through to envData when status.dcomm_date is null', () => {
    const envTs = '2026-04-14T12:00:00.000Z';
    expect(
      resolvedDcommDate({ dcomm_date: null }, { dcomm_date: envTs })
    ).toBe(envTs);
  });

  it('field is hidden (null) before decommission is triggered', () => {
    // Represents a freshly-deployed environment
    const resolved = resolvedDcommDate(
      { dcomm_date: null },
      { dcomm_date: null }
    );
    expect(resolved).toBeFalsy();
  });

  it('field is visible (truthy) after operator triggers decommission', () => {
    const ts = new Date().toISOString();
    const resolved = resolvedDcommDate(
      { dcomm_date: ts },
      { dcomm_date: ts }
    );
    expect(resolved).toBeTruthy();
  });
});
