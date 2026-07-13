/**
 * ADR-004 §7 conformance suite — the connector lifecycle HSM, pure. Region
 * composition, the serving-state projection (the ONLY lifecycle→serving
 * coupling), prohibited-composite enforcement, auto-resume gating, the
 * Throttled/class-1 rule, and the frozen §11.7 failure taxonomy.
 */
import { describe, it, expect } from '@jest/globals';
import {
  composeState,
  serviceState,
  isProhibitedComposite,
  assertTransition,
  outageClockStart,
  canResume,
  throttledPausesIndexingOnly,
  classifyFailure,
  FAILURE_TAXONOMY,
  type AuthState,
} from '../ConnectorLifecycle.js';
import { decideServing } from '../../permissions/contract.js';

describe('ADR-004 §3.1 — serving-state projection (lifecycle → ADR-010 gate)', () => {
  it('healthy → healthy; rotating → revalidating; degraded/read_only/disabled → degraded', () => {
    expect(serviceState('healthy')).toBe('healthy');
    expect(serviceState('rotating')).toBe('revalidating');
    expect(serviceState('degraded')).toBe('degraded');
    expect(serviceState('read_only')).toBe('degraded');
    expect(serviceState('disabled')).toBe('degraded');
  });

  it('INV-3: a degraded connector withholds Critical at the ADR-010 gate', () => {
    const decision = decideServing({
      freshnessClass: 'critical',
      complianceFlagged: false,
      connectorState: serviceState('degraded'),
      degradedSinceMs: 1000,
      nowMs: 2000,
    });
    expect(decision).toBe('withhold');
  });

  it('a healthy connector serves Critical (via live validation downstream)', () => {
    const decision = decideServing({
      freshnessClass: 'critical',
      complianceFlagged: false,
      connectorState: serviceState('healthy'),
      nowMs: 2000,
    });
    expect(decision).not.toBe('withhold');
  });
});

describe('ADR-004 §3.2 — prohibited composites (enforced at the transition)', () => {
  it('rejects indexing against a mid-migration schema', () => {
    expect(isProhibitedComposite(composeState('healthy', 'syncing', 'migrating'))).toBe(true);
    expect(isProhibitedComposite(composeState('healthy', 'backlog', 'migrating'))).toBe(true);
  });

  it('rejects any sync against an incompatible schema (full stop)', () => {
    expect(isProhibitedComposite(composeState('degraded', 'backlog', 'incompatible'))).toBe(true);
    expect(isProhibitedComposite(composeState('healthy', 'idle', 'incompatible'))).toBe(false);
  });

  it('rejects a disabled connector doing sync work', () => {
    expect(isProhibitedComposite(composeState('disabled', 'syncing', 'current'))).toBe(true);
    expect(isProhibitedComposite(composeState('disabled', 'idle', 'current'))).toBe(false);
  });

  it('accepts normal operation', () => {
    expect(isProhibitedComposite(composeState('healthy', 'idle', 'current'))).toBe(false);
    expect(isProhibitedComposite(composeState('degraded', 'idle', 'current'))).toBe(false);
  });

  it('assertTransition throws on a prohibited target, passes a legal one', () => {
    expect(() => assertTransition(
      composeState('healthy', 'idle', 'migrating'),
      composeState('healthy', 'syncing', 'migrating'),
    )).toThrow(/§3.2/);
    expect(() => assertTransition(
      composeState('healthy', 'idle', 'current'),
      composeState('healthy', 'syncing', 'current'),
    )).not.toThrow();
  });
});

describe('ADR-004 §3.3 — the outage clock', () => {
  it('starts at the healthy → non-healthy transition', () => {
    expect(outageClockStart('healthy', 'degraded', 5000)).toBe(5000);
    expect(outageClockStart('degraded', 'read_only', 6000)).toBeUndefined(); // already degraded
    expect(outageClockStart('healthy', 'healthy', 7000)).toBeUndefined();
  });
});

describe('ADR-004 §3.4 — auto-resume requires Healthy AND revalidation', () => {
  it('Healthy alone never resumes', () => {
    expect(canResume('healthy', false)).toBe(false);
  });
  it('Healthy + one revalidation pass resumes', () => {
    expect(canResume('healthy', true)).toBe(true);
  });
  it('revalidation without Healthy never resumes', () => {
    const notHealthy: AuthState[] = ['degraded', 'rotating', 'read_only', 'disabled'];
    for (const a of notHealthy) expect(canResume(a, true)).toBe(false);
  });
});

describe('ADR-004 §7.5 — Throttled pauses indexing but never class-1 (INV-9)', () => {
  it('class-1 is never in the paused set', () => {
    const { pausesClasses, neverSheds } = throttledPausesIndexingOnly();
    expect(neverSheds).toEqual([1]);
    expect(pausesClasses).not.toContain(1);
  });
});

describe('ADR-004 §3.5 — frozen failure taxonomy', () => {
  it('has exactly 11 rows, each self-owned', () => {
    expect(Object.keys(FAILURE_TAXONOMY)).toHaveLength(11);
    for (const [key, row] of Object.entries(FAILURE_TAXONOMY)) {
      expect(row.type).toBe(key);
      expect(row.ownerMechanism.length).toBeGreaterThan(0);
    }
  });

  it('classifies by HTTP status', () => {
    expect(classifyFailure({ httpStatus: 429 }).type).toBe('quota_exhaustion');
    expect(classifyFailure({ httpStatus: 403 }).type).toBe('permanent');
    expect(classifyFailure({ httpStatus: 503 }).type).toBe('transient');
    expect(classifyFailure({ httpStatus: 0 }).type).toBe('connectivity_loss');
  });

  it('classifies an explicit kind', () => {
    expect(classifyFailure({ kind: 'split_brain' }).ownerMechanism).toMatch(/fencing/);
  });

  it('THROWS on a signal matching no row (a new row is required, §8)', () => {
    expect(() => classifyFailure({ httpStatus: 418 })).toThrow(/no failure taxonomy row/);
    expect(() => classifyFailure({})).toThrow(/neither kind nor httpStatus/);
  });
});
