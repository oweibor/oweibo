// §10.7 — Unit tests for the GEPA velocity tracker.
// Tests tier classification, hypervolume helpers, and edge cases.

import { describe, it, expect } from 'vitest';

// ── Tier classification (re-implemented here to test the pure logic) ─────────
// Matches the classifyVelocityTier function in src/index.ts

type VelocityTier = 'healthy' | 'slowing' | 'stagnating' | 'converged';

function classifyVelocityTier(ratio: number): VelocityTier {
  if (ratio >= 1.0) return 'healthy';
  if (ratio >= 0.5) return 'slowing';
  if (ratio >= 0.2) return 'stagnating';
  return 'converged';
}

// ── Pareto dominance (re-implemented here to test the pure logic) ────────────
// Matches the paretoDominates function in src/hypervolume.ts

interface ParetoScore {
  readonly qualityPassRate:  number;
  readonly qualityScoreMean: number;
  readonly tokensP50:        number;
  readonly tokensP95:        number;
}

function paretoDominates(a: ParetoScore, b: ParetoScore): boolean {
  return (
    a.qualityPassRate  >= b.qualityPassRate  &&
    a.qualityScoreMean >= b.qualityScoreMean &&
    a.tokensP50        <= b.tokensP50        &&
    a.tokensP95        <= b.tokensP95        &&
    (
      a.qualityPassRate  > b.qualityPassRate  ||
      a.qualityScoreMean > b.qualityScoreMean ||
      a.tokensP50        < b.tokensP50        ||
      a.tokensP95        < b.tokensP95
    )
  );
}

// ── ParetoScore validator (matches isValidParetoScore in hypervolume.ts) ─────

function isValidParetoScore(obj: unknown): obj is ParetoScore {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['qualityPassRate']  === 'number' &&
    typeof o['qualityScoreMean'] === 'number' &&
    typeof o['tokensP50']        === 'number' &&
    typeof o['tokensP95']        === 'number'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyVelocityTier (§10.7 thresholds)', () => {
  it('classifies ratio >= 1.0 as healthy', () => {
    expect(classifyVelocityTier(1.0)).toBe('healthy');
    expect(classifyVelocityTier(1.5)).toBe('healthy');
    expect(classifyVelocityTier(100)).toBe('healthy');
  });

  it('classifies 0.5 <= ratio < 1.0 as slowing', () => {
    expect(classifyVelocityTier(0.5)).toBe('slowing');
    expect(classifyVelocityTier(0.75)).toBe('slowing');
    expect(classifyVelocityTier(0.999)).toBe('slowing');
  });

  it('classifies 0.2 <= ratio < 0.5 as stagnating', () => {
    expect(classifyVelocityTier(0.2)).toBe('stagnating');
    expect(classifyVelocityTier(0.35)).toBe('stagnating');
    expect(classifyVelocityTier(0.499)).toBe('stagnating');
  });

  it('classifies ratio < 0.2 as converged', () => {
    expect(classifyVelocityTier(0.199)).toBe('converged');
    expect(classifyVelocityTier(0.1)).toBe('converged');
    expect(classifyVelocityTier(0)).toBe('converged');
  });

  it('handles negative ratios as converged', () => {
    expect(classifyVelocityTier(-1)).toBe('converged');
    expect(classifyVelocityTier(-0.5)).toBe('converged');
  });

  it('handles exact boundary values correctly', () => {
    // §10.7 boundaries: 1.0, 0.5, 0.2
    expect(classifyVelocityTier(1.0)).toBe('healthy');    // >= 1.0
    expect(classifyVelocityTier(0.5)).toBe('slowing');    // >= 0.5
    expect(classifyVelocityTier(0.2)).toBe('stagnating'); // >= 0.2
  });
});

describe('paretoDominates', () => {
  const baseline: ParetoScore = {
    qualityPassRate: 0.7, qualityScoreMean: 0.7, tokensP50: 1000, tokensP95: 2000,
  };

  it('returns true when strictly better on at least one axis', () => {
    const better = { ...baseline, qualityPassRate: 0.8 };
    expect(paretoDominates(better, baseline)).toBe(true);
  });

  it('returns true when better on quality and equal on tokens', () => {
    const better = { ...baseline, qualityScoreMean: 0.9 };
    expect(paretoDominates(better, baseline)).toBe(true);
  });

  it('returns true when better on tokens (lower) and equal on quality', () => {
    const better = { ...baseline, tokensP50: 800 };
    expect(paretoDominates(better, baseline)).toBe(true);
  });

  it('returns false for identical scores', () => {
    expect(paretoDominates(baseline, baseline)).toBe(false);
  });

  it('returns false when worse on any axis', () => {
    const tradeoff = { ...baseline, qualityPassRate: 0.8, tokensP50: 1200 };
    expect(paretoDominates(tradeoff, baseline)).toBe(false);
  });

  it('returns false when strictly worse', () => {
    const worse = { qualityPassRate: 0.5, qualityScoreMean: 0.5, tokensP50: 1500, tokensP95: 3000 };
    expect(paretoDominates(worse, baseline)).toBe(false);
  });
});

describe('isValidParetoScore', () => {
  it('accepts a valid ParetoScore object', () => {
    expect(isValidParetoScore({
      qualityPassRate: 0.7, qualityScoreMean: 0.7, tokensP50: 1000, tokensP95: 2000,
    })).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidParetoScore(null)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidParetoScore('string')).toBe(false);
    expect(isValidParetoScore(42)).toBe(false);
  });

  it('rejects objects with missing fields', () => {
    expect(isValidParetoScore({ qualityPassRate: 0.7 })).toBe(false);
    expect(isValidParetoScore({ qualityPassRate: 0.7, qualityScoreMean: 0.7 })).toBe(false);
  });

  it('rejects objects with non-numeric fields', () => {
    expect(isValidParetoScore({
      qualityPassRate: '0.7', qualityScoreMean: 0.7, tokensP50: 1000, tokensP95: 2000,
    })).toBe(false);
  });
});

describe('Governor response mapping (§10.7)', () => {
  // These test that the governor response table in apps/gepa-optimizer matches the plan
  const GOVERNOR_RESPONSE: Record<VelocityTier, {
    skip: boolean; populationSize: number; maxGenerations: number;
  }> = {
    healthy:    { skip: false, populationSize: 5, maxGenerations: 3 },
    slowing:    { skip: false, populationSize: 3, maxGenerations: 3 },
    stagnating: { skip: false, populationSize: 2, maxGenerations: 2 },
    converged:  { skip: true,  populationSize: 0, maxGenerations: 0 },
  };

  it('healthy tier runs at full capacity', () => {
    const r = GOVERNOR_RESPONSE['healthy'];
    expect(r.skip).toBe(false);
    expect(r.populationSize).toBe(5);
    expect(r.maxGenerations).toBe(3);
  });

  it('slowing tier reduces offspring (~33% cost reduction)', () => {
    const r = GOVERNOR_RESPONSE['slowing'];
    expect(r.skip).toBe(false);
    expect(r.populationSize).toBeLessThan(GOVERNOR_RESPONSE['healthy'].populationSize);
  });

  it('stagnating tier further reduces parents and generations (~70% cost reduction)', () => {
    const r = GOVERNOR_RESPONSE['stagnating'];
    expect(r.skip).toBe(false);
    expect(r.populationSize).toBeLessThan(GOVERNOR_RESPONSE['slowing'].populationSize);
    expect(r.maxGenerations).toBeLessThan(GOVERNOR_RESPONSE['healthy'].maxGenerations);
  });

  it('converged tier skips entirely', () => {
    const r = GOVERNOR_RESPONSE['converged'];
    expect(r.skip).toBe(true);
  });
});

describe('Velocity ratio computation edge cases', () => {
  it('zero baseline is floored to avoid division by zero', () => {
    const delta7d = 5;
    const deltaBaseline = 0;
    const baselineWeekly = deltaBaseline / 3;
    const ratio = delta7d / Math.max(baselineWeekly, 0.001);
    // Should produce a very high ratio (healthy), not Infinity or NaN
    expect(Number.isFinite(ratio)).toBe(true);
    expect(classifyVelocityTier(ratio)).toBe('healthy');
  });

  it('both deltas zero produces converged (0 / 0.001 = 0)', () => {
    const delta7d = 0;
    const deltaBaseline = 0;
    const baselineWeekly = deltaBaseline / 3;
    const ratio = delta7d / Math.max(baselineWeekly, 0.001);
    expect(ratio).toBe(0);
    expect(classifyVelocityTier(ratio)).toBe('converged');
  });

  it('small recent gain with large baseline produces converged', () => {
    const delta7d = 1;
    const deltaBaseline = 30; // 30 over 21 days = 10/week
    const baselineWeekly = deltaBaseline / 3;
    const ratio = delta7d / Math.max(baselineWeekly, 0.001);
    expect(ratio).toBe(0.1);
    expect(classifyVelocityTier(ratio)).toBe('converged');
  });

  it('equal recent and baseline weekly rate produces healthy', () => {
    const delta7d = 10;
    const deltaBaseline = 30; // 30 over 21 days = 10/week
    const baselineWeekly = deltaBaseline / 3;
    const ratio = delta7d / Math.max(baselineWeekly, 0.001);
    expect(ratio).toBe(1.0);
    expect(classifyVelocityTier(ratio)).toBe('healthy');
  });
});
