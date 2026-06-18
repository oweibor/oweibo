/**
 * S.0 — BlastRadiusComputer aggregation tests.
 */
import { BlastRadiusComputer } from '../BlastRadiusComputer.js';
import type { BlastRadiusContribution } from '@oweibo/core-contracts';

describe('BlastRadiusComputer.aggregate', () => {
  it('returns the empty radius for zero contributions', () => {
    const r = BlastRadiusComputer.aggregate([]);
    expect(r.systems).toEqual([]);
    expect(r.dataDomains).toEqual([]);
    expect(r.worstReversibility).toBe('trivial');
    expect(r.estimatedCostUsdCents).toBe(0);
    expect(r.estimatedReachUserCount).toBe(0);
  });

  it('set-unions systems and dataDomains (sorted, deduplicated)', () => {
    const r = BlastRadiusComputer.aggregate([
      { systems: ['github', 'slack'], dataDomains: ['code'], reversibility: 'trivial', costUsdCents: 0, reachUserCount: 0 },
      { systems: ['slack', 'stripe'], dataDomains: ['code', 'billing'], reversibility: 'trivial', costUsdCents: 0, reachUserCount: 0 },
    ]);
    expect(r.systems).toEqual(['github', 'slack', 'stripe']);
    expect(r.dataDomains).toEqual(['billing', 'code']);
  });

  it('takes the worst reversibility (least reversible wins)', () => {
    const r = BlastRadiusComputer.aggregate([
      { systems: [], dataDomains: [], reversibility: 'trivial', costUsdCents: 0, reachUserCount: 0 },
      { systems: [], dataDomains: [], reversibility: 'reversible_with_cost', costUsdCents: 0, reachUserCount: 0 },
      { systems: [], dataDomains: [], reversibility: 'irreversible', costUsdCents: 0, reachUserCount: 0 },
    ]);
    expect(r.worstReversibility).toBe('irreversible');
  });

  it('sums costs and clamps negatives to zero', () => {
    const r = BlastRadiusComputer.aggregate([
      { systems: [], dataDomains: [], reversibility: 'trivial', costUsdCents: 100, reachUserCount: 0 },
      { systems: [], dataDomains: [], reversibility: 'trivial', costUsdCents: -50, reachUserCount: 0 },
      { systems: [], dataDomains: [], reversibility: 'trivial', costUsdCents: 200, reachUserCount: 0 },
    ]);
    expect(r.estimatedCostUsdCents).toBe(300);
  });

  it('takes max reach (not sum — same end-user observing two actions is one observation)', () => {
    const r = BlastRadiusComputer.aggregate([
      { systems: [], dataDomains: [], reversibility: 'trivial', costUsdCents: 0, reachUserCount: 100 },
      { systems: [], dataDomains: [], reversibility: 'trivial', costUsdCents: 0, reachUserCount: 50 },
      { systems: [], dataDomains: [], reversibility: 'trivial', costUsdCents: 0, reachUserCount: 250 },
    ]);
    expect(r.estimatedReachUserCount).toBe(250);
  });

  it('is stable: same input → same output (sorted set output)', () => {
    const input: BlastRadiusContribution[] = [
      { systems: ['z', 'a'], dataDomains: [], reversibility: 'trivial', costUsdCents: 0, reachUserCount: 0 },
    ];
    const a = BlastRadiusComputer.aggregate(input);
    const b = BlastRadiusComputer.aggregate(input);
    expect(a).toEqual(b);
    expect(a.systems).toEqual(['a', 'z']);
  });
});
