/**
 * ADR-013 conformance: the scheduler contract predicates (INV-8, INV-9).
 *
 * Interim executable conformance at ADR-013 ratification. The full enforcement
 * battery (kill-worker-mid-job, stale-token-rejected-on-write, class-flood)
 * arrives at K.0 against live kf_jobs/kf_leases.
 */
import {
  isFencingTokenStale,
  selectShedClass,
  NEVER_SHED_CLASS,
  type JobClass,
} from '../contract';

describe('INV-8 — fencing token (isFencingTokenStale)', () => {
  it('rejects a strictly lower (stale) token', () => {
    expect(isFencingTokenStale(4n, 7n)).toBe(true);
  });

  it('accepts the current high-water token (idempotent retry within the lease)', () => {
    expect(isFencingTokenStale(7n, 7n)).toBe(false);
  });

  it('accepts a higher token (fresh re-acquire)', () => {
    expect(isFencingTokenStale(8n, 7n)).toBe(false);
  });

  it('an expired-then-reacquired worker is caught: old holder token < new high-water', () => {
    // Holder A acquired at token 5; lease lapsed; holder B re-acquired at 6.
    // A's late write presents 5 against a target that has seen 6.
    const currentHighWater = 6n;
    const laggingHolderWrite = 5n;
    expect(isFencingTokenStale(laggingHolderWrite, currentHighWater)).toBe(true);
  });
});

describe('INV-9 — load shedding (selectShedClass)', () => {
  const depths = (partial: Partial<Record<JobClass, number>>): Record<JobClass, number> => ({
    1: 0, 2: 0, 3: 0, 4: 0, 5: 0, ...partial,
  });

  it('sheds the lowest-priority class with work first (class 5 before 4)', () => {
    expect(selectShedClass(depths({ 4: 10, 5: 3 }))).toBe(5);
  });

  it('sheds class 4 when 5 is empty', () => {
    expect(selectShedClass(depths({ 2: 100, 4: 10 }))).toBe(4);
  });

  it('returns null when only class 1 has work — nothing may be shed', () => {
    expect(selectShedClass(depths({ 1: 9999 }))).toBeNull();
  });

  it('returns null on an empty queue', () => {
    expect(selectShedClass(depths({}))).toBeNull();
  });

  it('NEVER returns class 1, even when class 1 is the deepest queue', () => {
    // Exhaustive: for every combination that includes a loaded class 1,
    // the result is never the never-shed class.
    for (const c of [2, 3, 4, 5] as JobClass[]) {
      const result = selectShedClass(depths({ 1: 1_000_000, [c]: 1 }));
      expect(result).not.toBe(NEVER_SHED_CLASS);
      expect(result).toBe(c);
    }
  });
});
