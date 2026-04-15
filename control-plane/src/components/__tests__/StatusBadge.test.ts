/**
 * StatusBadge unit tests
 *
 * Tests run in a pure Node environment — no DOM / jsdom needed.  We test the
 * exported STATUS_CONFIG data structure and the FALLBACK_CONFIG directly,
 * which is where all the visual-logic decisions live.
 */
import { describe, it, expect } from 'vitest';
import {
  STATUS_CONFIG,
  FALLBACK_CONFIG,
  type DeployStatus,
  type StatusConfig,
} from '../StatusBadge';

// Every DeployStatus value that the database state machine can produce.
const ALL_STATUSES: DeployStatus[] = [
  'pending',
  'provisioning',
  'deployed',
  'reconfiguring',
  'stopping',
  'failed',
  'stopped',
  'decommissioning',
  'decommissioned',
];

// ── Coverage completeness ──────────────────────────────────────────────────

describe('STATUS_CONFIG completeness', () => {
  it('has an entry for every DeployStatus value', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_CONFIG).toHaveProperty(status);
    }
  });

  it('has no extra entries beyond the known statuses', () => {
    const configuredKeys = Object.keys(STATUS_CONFIG).sort();
    const expectedKeys = [...ALL_STATUSES].sort();
    expect(configuredKeys).toEqual(expectedKeys);
  });

  it('each entry has all required fields', () => {
    for (const status of ALL_STATUSES) {
      const cfg: StatusConfig = STATUS_CONFIG[status];
      expect(cfg.label, `${status}.label`).toBeTypeOf('string');
      expect(cfg.label.length, `${status}.label must be non-empty`).toBeGreaterThan(0);
      expect(cfg.classes, `${status}.classes`).toBeTypeOf('string');
      expect(cfg.dot, `${status}.dot`).toBeTypeOf('string');
      expect(cfg.animated, `${status}.animated`).toBeTypeOf('boolean');
    }
  });
});

// ── Label text ─────────────────────────────────────────────────────────────

describe('STATUS_CONFIG labels', () => {
  const expectedLabels: Record<DeployStatus, string> = {
    pending: 'Pending',
    provisioning: 'Provisioning',
    deployed: 'Deployed',
    reconfiguring: 'Reconfiguring',
    stopping: 'Stopping',
    failed: 'Failed',
    stopped: 'Stopped',
    decommissioning: 'Decommissioning',
    decommissioned: 'Decommissioned',
  };

  for (const [status, label] of Object.entries(expectedLabels) as [DeployStatus, string][]) {
    it(`"${status}" has label "${label}"`, () => {
      expect(STATUS_CONFIG[status].label).toBe(label);
    });
  }
});

// ── Animation semantics ────────────────────────────────────────────────────
//
// Animated states represent in-progress transitions where the worker is
// actively operating on the environment.  Static states are terminal or
// quiescent.

describe('animated flag', () => {
  const animatedStates: DeployStatus[] = ['provisioning', 'reconfiguring', 'stopping', 'decommissioning'];
  const staticStates: DeployStatus[] = ['pending', 'deployed', 'failed', 'stopped', 'decommissioned'];

  it.each(animatedStates)('"%s" is animated (worker is active)', (status) => {
    expect(STATUS_CONFIG[status].animated).toBe(true);
  });

  it.each(staticStates)('"%s" is NOT animated (terminal / quiescent)', (status) => {
    expect(STATUS_CONFIG[status].animated).toBe(false);
  });
});

// ── Colour families ────────────────────────────────────────────────────────

describe('colour families', () => {
  it('"pending" uses yellow colour family', () => {
    expect(STATUS_CONFIG.pending.classes).toContain('yellow');
    expect(STATUS_CONFIG.pending.dot).toContain('yellow');
  });

  it('"provisioning" uses blue colour family', () => {
    expect(STATUS_CONFIG.provisioning.classes).toContain('blue');
    expect(STATUS_CONFIG.provisioning.dot).toContain('blue');
  });

  it('"deployed" uses green colour family', () => {
    expect(STATUS_CONFIG.deployed.classes).toContain('green');
    expect(STATUS_CONFIG.deployed.dot).toContain('green');
  });

  it('"reconfiguring" uses purple colour family', () => {
    expect(STATUS_CONFIG.reconfiguring.classes).toContain('purple');
    expect(STATUS_CONFIG.reconfiguring.dot).toContain('purple');
  });

  it('"stopping" uses orange colour family', () => {
    expect(STATUS_CONFIG.stopping.classes).toContain('orange');
    expect(STATUS_CONFIG.stopping.dot).toContain('orange');
  });

  it('"failed" uses red colour family', () => {
    expect(STATUS_CONFIG.failed.classes).toContain('red');
    expect(STATUS_CONFIG.failed.dot).toContain('red');
  });

  it('"stopped" uses gray colour family', () => {
    expect(STATUS_CONFIG.stopped.classes).toContain('gray');
  });

  it('"decommissioning" uses teal colour family', () => {
    expect(STATUS_CONFIG.decommissioning.classes).toContain('teal');
    expect(STATUS_CONFIG.decommissioning.dot).toContain('teal');
  });

  it('"decommissioned" uses slate colour family', () => {
    expect(STATUS_CONFIG.decommissioned.classes).toContain('slate');
  });
});

// ── Dark-mode classes ──────────────────────────────────────────────────────

describe('dark mode support', () => {
  it.each(ALL_STATUSES)('"%s" has dark: variant in classes', (status) => {
    expect(STATUS_CONFIG[status].classes).toMatch(/dark:/);
  });

  it.each(ALL_STATUSES)('"%s" has dark: variant in dot', (status) => {
    expect(STATUS_CONFIG[status].dot).toMatch(/dark:/);
  });
});

// ── Fallback for unknown statuses ──────────────────────────────────────────

describe('FALLBACK_CONFIG', () => {
  it('capitalises the first letter of an unknown status', () => {
    expect(FALLBACK_CONFIG.label('unknown')).toBe('Unknown');
    expect(FALLBACK_CONFIG.label('some_new_state')).toBe('Some_new_state');
  });

  it('has non-empty classes', () => {
    expect(FALLBACK_CONFIG.classes.length).toBeGreaterThan(0);
  });

  it('is not animated', () => {
    expect(FALLBACK_CONFIG.animated).toBe(false);
  });

  it('correctly falls back when STATUS_CONFIG does not have the key', () => {
    const unknownStatus = 'whatever_future_state' as DeployStatus;
    const config = STATUS_CONFIG[unknownStatus];
    // STATUS_CONFIG does not have this key — undefined triggers fallback path
    expect(config).toBeUndefined();
    // Consumers should use FALLBACK_CONFIG when config is undefined
    expect(FALLBACK_CONFIG.label('whatever_future_state')).toBe('Whatever_future_state');
  });
});

// ── Tailwind class structure ───────────────────────────────────────────────

describe('Tailwind class structure', () => {
  it.each(ALL_STATUSES)(
    '"%s" classes include background and text utilities',
    (status) => {
      const { classes } = STATUS_CONFIG[status];
      expect(classes).toMatch(/bg-/);
      expect(classes).toMatch(/text-/);
    }
  );

  it.each(ALL_STATUSES)(
    '"%s" dot classes include a background utility',
    (status) => {
      expect(STATUS_CONFIG[status].dot).toMatch(/bg-/);
    }
  );

  it('animated states do NOT embed animate-pulse in their badge classes (pulse is on the dot)', () => {
    // The animate-pulse class should NOT be on the outer badge wrapper classes;
    // it is applied only to the dot span inside the component.
    for (const status of ['provisioning', 'reconfiguring', 'stopping', 'decommissioning'] as DeployStatus[]) {
      expect(STATUS_CONFIG[status].classes).not.toContain('animate-pulse');
    }
  });
});

// ── Four intermediate states — distinct visual variants ───────────────────
//
// AC 110201: All four in-progress states must have distinct badge configs
// (colour family, animated dot, label) so operators can immediately identify
// what the worker is currently doing to their environment.

describe('four intermediate states have distinct visual variants', () => {
  const INTERMEDIATE: DeployStatus[] = ['provisioning', 'reconfiguring', 'stopping', 'decommissioning'];

  it('all four intermediate states are animated', () => {
    for (const status of INTERMEDIATE) {
      expect(STATUS_CONFIG[status].animated, `${status} must be animated`).toBe(true);
    }
  });

  it('all four intermediate states have unique colour families', () => {
    // Extract the primary colour keyword from each classes string (e.g. "blue", "purple")
    const colourFamilies = INTERMEDIATE.map((status) => {
      const match = STATUS_CONFIG[status].classes.match(/bg-(\w+)-/);
      return match ? match[1] : null;
    });

    // Every colour family must be non-null (has a bg- class)
    for (let i = 0; i < INTERMEDIATE.length; i++) {
      expect(colourFamilies[i], `${INTERMEDIATE[i]} must have a colour family`).not.toBeNull();
    }

    // All colour families must be unique — no two intermediate states share a colour
    const uniqueFamilies = new Set(colourFamilies);
    expect(uniqueFamilies.size).toBe(INTERMEDIATE.length);
  });

  it('all four intermediate states have unique labels', () => {
    const labels = INTERMEDIATE.map((s) => STATUS_CONFIG[s].label);
    const uniqueLabels = new Set(labels);
    expect(uniqueLabels.size).toBe(INTERMEDIATE.length);
  });

  it('all four intermediate states have unique dot classes', () => {
    const dots = INTERMEDIATE.map((s) => STATUS_CONFIG[s].dot);
    const uniqueDots = new Set(dots);
    expect(uniqueDots.size).toBe(INTERMEDIATE.length);
  });

  // Individual state assertions — belt-and-suspenders specifics

  it('"provisioning" — blue animated badge signals namespace + k8s resource creation', () => {
    const cfg = STATUS_CONFIG.provisioning;
    expect(cfg.animated).toBe(true);
    expect(cfg.label).toBe('Provisioning');
    expect(cfg.classes).toContain('blue');
    expect(cfg.dot).toContain('blue');
    expect(cfg.classes).toContain('dark:');
    expect(cfg.dot).toContain('dark:');
  });

  it('"reconfiguring" — purple animated badge signals kustomize patch in flight', () => {
    const cfg = STATUS_CONFIG.reconfiguring;
    expect(cfg.animated).toBe(true);
    expect(cfg.label).toBe('Reconfiguring');
    expect(cfg.classes).toContain('purple');
    expect(cfg.dot).toContain('purple');
    expect(cfg.classes).toContain('dark:');
    expect(cfg.dot).toContain('dark:');
  });

  it('"stopping" — orange animated badge signals scale-to-zero in progress', () => {
    const cfg = STATUS_CONFIG.stopping;
    expect(cfg.animated).toBe(true);
    expect(cfg.label).toBe('Stopping');
    expect(cfg.classes).toContain('orange');
    expect(cfg.dot).toContain('orange');
    expect(cfg.classes).toContain('dark:');
    expect(cfg.dot).toContain('dark:');
  });

  it('"decommissioning" — teal animated badge signals full teardown in progress', () => {
    const cfg = STATUS_CONFIG.decommissioning;
    expect(cfg.animated).toBe(true);
    expect(cfg.label).toBe('Decommissioning');
    expect(cfg.classes).toContain('teal');
    expect(cfg.dot).toContain('teal');
    expect(cfg.classes).toContain('dark:');
    expect(cfg.dot).toContain('dark:');
  });

  it('"decommissioning" is visually distinct from its terminal sibling "decommissioned"', () => {
    const inProgress = STATUS_CONFIG.decommissioning;
    const terminal = STATUS_CONFIG.decommissioned;

    // Must differ in animation
    expect(inProgress.animated).toBe(true);
    expect(terminal.animated).toBe(false);

    // Must differ in label
    expect(inProgress.label).not.toBe(terminal.label);

    // Must differ in colour family
    const inProgressFamily = inProgress.classes.match(/bg-(\w+)-/)?.[1];
    const terminalFamily = terminal.classes.match(/bg-(\w+)-/)?.[1];
    expect(inProgressFamily).not.toBe(terminalFamily);
  });

  it('intermediate states are visually distinct from all terminal/quiescent states', () => {
    const terminalStates: DeployStatus[] = ['pending', 'deployed', 'failed', 'stopped', 'decommissioned'];

    for (const intermediate of INTERMEDIATE) {
      for (const terminal of terminalStates) {
        // At minimum the animated flag must differ between in-progress and quiescent
        // (quiescent are all false; intermediate are all true)
        expect(STATUS_CONFIG[intermediate].animated).not.toBe(
          STATUS_CONFIG[terminal].animated,
        );
      }
    }
  });
});
