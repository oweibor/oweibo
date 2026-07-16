/**
 * ADR-010 conformance — the §3.5 withholding state machine (INV-3), the
 * §3.1 snapshot gate, and the INV-9 membership job-class assignment.
 * Every §6.6 table row is pinned.
 */
import {
  decideServing,
  snapshotWithinBound,
  DEFAULT_STALENESS_BOUNDS_MS,
  MEMBERSHIP_DELTA_JOB_CLASS,
  MEMBERSHIP_BOOTSTRAP_JOB_CLASS,
} from '../contract.js';
import { NEVER_SHED_CLASS } from '../../scheduler/contract.js';

const T0 = 1_760_000_000_000;

describe('decideServing (§3.5 / §6.6 table)', () => {
  it('healthy serves everything untagged', () => {
    for (const cls of ['static', 'operational', 'transactional', 'critical'] as const) {
      expect(decideServing({
        freshnessClass: cls, complianceFlagged: false,
        connectorState: 'healthy', nowMs: T0,
      })).toBe('serve');
    }
  });

  it('critical is withheld at the Degraded transition itself — zero grace (Appendix A #4)', () => {
    expect(decideServing({
      freshnessClass: 'critical', complianceFlagged: false,
      connectorState: 'degraded', degradedSinceMs: T0, nowMs: T0,  // same instant
    })).toBe('withhold');
  });

  it('compliance-flagged content of ANY class is treated as critical (§6.4)', () => {
    expect(decideServing({
      freshnessClass: 'static', complianceFlagged: true,
      connectorState: 'degraded', degradedSinceMs: T0, nowMs: T0 + 1,
    })).toBe('withhold');
  });

  it('within-bound outages serve normally for non-critical classes', () => {
    expect(decideServing({
      freshnessClass: 'operational', complianceFlagged: false,
      connectorState: 'degraded', degradedSinceMs: T0,
      nowMs: T0 + DEFAULT_STALENESS_BOUNDS_MS.operational,  // exactly at bound
    })).toBe('serve');
  });

  it('beyond bound: static untagged, operational tagged, transactional tagged+logged', () => {
    const beyond = (cls: 'static' | 'operational' | 'transactional') =>
      decideServing({
        freshnessClass: cls, complianceFlagged: false,
        connectorState: 'degraded', degradedSinceMs: T0,
        nowMs: T0 + DEFAULT_STALENESS_BOUNDS_MS[cls] + 1,
      });
    expect(beyond('static')).toBe('serve');
    expect(beyond('operational')).toBe('serve_stale_tagged');
    expect(beyond('transactional')).toBe('serve_tagged_logged');
  });

  it('degraded without a transition timestamp fails toward beyond-bound behavior', () => {
    expect(decideServing({
      freshnessClass: 'operational', complianceFlagged: false,
      connectorState: 'degraded', nowMs: T0,
    })).toBe('serve_stale_tagged');
    expect(decideServing({
      freshnessClass: 'critical', complianceFlagged: false,
      connectorState: 'degraded', nowMs: T0,
    })).toBe('withhold');
  });

  it('revalidating: critical/compliance stay withheld until the pass completes; others serve tagged', () => {
    expect(decideServing({
      freshnessClass: 'critical', complianceFlagged: false,
      connectorState: 'revalidating', nowMs: T0,
    })).toBe('withhold');
    expect(decideServing({
      freshnessClass: 'transactional', complianceFlagged: true,
      connectorState: 'revalidating', nowMs: T0,
    })).toBe('withhold');
    expect(decideServing({
      freshnessClass: 'operational', complianceFlagged: false,
      connectorState: 'revalidating', nowMs: T0,
    })).toBe('serve_stale_tagged');
    expect(decideServing({
      freshnessClass: 'static', complianceFlagged: false,
      connectorState: 'revalidating', nowMs: T0,
    })).toBe('serve');
  });

  it('ops-tunable bounds are honored — but critical stays 0 in the defaults (Fixed)', () => {
    expect(decideServing({
      freshnessClass: 'operational', complianceFlagged: false,
      connectorState: 'degraded', degradedSinceMs: T0, nowMs: T0 + 10_000,
      boundsMs: { ...DEFAULT_STALENESS_BOUNDS_MS, operational: 5_000 },
    })).toBe('serve_stale_tagged');
    expect(DEFAULT_STALENESS_BOUNDS_MS.critical).toBe(0);
  });
});

describe('snapshotWithinBound (§3.1 read-through gate)', () => {
  it('critical/compliance snapshots are NEVER fresh enough — always live (INV-3)', () => {
    expect(snapshotWithinBound({
      freshnessClass: 'critical', complianceFlagged: false,
      lastCheckedMs: T0, nowMs: T0,  // checked this very instant
    })).toBe(false);
    expect(snapshotWithinBound({
      freshnessClass: 'static', complianceFlagged: true,
      lastCheckedMs: T0, nowMs: T0,
    })).toBe(false);
  });

  it('other classes trust the snapshot within their bound and refresh beyond it', () => {
    expect(snapshotWithinBound({
      freshnessClass: 'transactional', complianceFlagged: false,
      lastCheckedMs: T0, nowMs: T0 + 59_000,
    })).toBe(true);
    expect(snapshotWithinBound({
      freshnessClass: 'transactional', complianceFlagged: false,
      lastCheckedMs: T0, nowMs: T0 + 61_000,
    })).toBe(false);
  });
});

describe('membership job classes (INV-9 assignment, §3.2)', () => {
  it('membership deltas run in the never-shed class-1 lane; bootstrap crawls are class-2', () => {
    expect(MEMBERSHIP_DELTA_JOB_CLASS).toBe(NEVER_SHED_CLASS);
    expect(MEMBERSHIP_BOOTSTRAP_JOB_CLASS).toBe(2);
  });
});
