/**
 * K.0: RetryManager policy unit tests (ADR-013 §3.5/§6).
 */
import { RetryManager, DEFAULT_RETRY_BUDGETS } from '../RetryManager';
import type { JobClass } from '../contract';

describe('RetryManager (ADR-013 §3.5)', () => {
  it('dead-letters exactly at the class budget, not before', () => {
    const rm = new RetryManager();
    for (const c of [1, 2, 3, 4, 5] as JobClass[]) {
      const budget = DEFAULT_RETRY_BUDGETS[c];
      expect(rm.shouldDeadLetter(c, budget - 1)).toBe(false);
      expect(rm.shouldDeadLetter(c, budget)).toBe(true);
    }
  });

  it('class-5 (activity signals) barely retries — budget 1', () => {
    const rm = new RetryManager();
    expect(rm.shouldDeadLetter(5, 1)).toBe(true);
  });

  it('backoff grows exponentially under pinned randomness', () => {
    const rm = new RetryManager({ random: () => 1 - Number.EPSILON, baseMs: 1000, capMs: 60_000 });
    const b1 = rm.backoffMs(1);
    const b2 = rm.backoffMs(2);
    const b3 = rm.backoffMs(3);
    expect(b2).toBeGreaterThan(b1);
    expect(b3).toBeGreaterThan(b2);
  });

  it('backoff is capped', () => {
    const rm = new RetryManager({ random: () => 1 - Number.EPSILON, baseMs: 1000, capMs: 4000 });
    expect(rm.backoffMs(10)).toBeLessThanOrEqual(4000);
  });

  it('full jitter: zero randomness → zero delay (jitter spans the full range)', () => {
    const rm = new RetryManager({ random: () => 0 });
    expect(rm.backoffMs(3)).toBe(0);
  });
});
