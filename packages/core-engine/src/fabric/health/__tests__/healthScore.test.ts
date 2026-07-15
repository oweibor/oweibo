/**
 * K.9 / §23 — health score + SLO conformance.
 */
import {
  HEALTH_WEIGHTS,
  PLANNER_INDEX_BIAS_THRESHOLD,
  healthScore,
  livePathBias,
  type HealthInputs,
} from '../healthScore';
import { SLO_TABLE, evaluateSlo } from '../sloContract';

const healthy: HealthInputs = {
  auth: 1, syncFreshness: 1, jobSuccess: 1, quotaHeadroom: 1,
  liveLatency: 1, aclRefresh: 1, indexCoverage: 1,
};

describe('§23 — connector health score', () => {
  it('a fully healthy connector scores 100', () => {
    expect(healthScore(healthy)).toBe(100);
  });

  it('a fully failed connector scores 0', () => {
    expect(healthScore({ auth: 0, syncFreshness: 0, jobSuccess: 0, quotaHeadroom: 0, liveLatency: 0, aclRefresh: 0, indexCoverage: 0 })).toBe(0);
  });

  it('the weights sum to 1 (a proper weighted average)', () => {
    const sum = Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it('auth and ACL-refresh carry the most weight — permission-correctness signals', () => {
    // A connector that cannot authenticate or refresh ACLs is dangerous, not slow.
    expect(HEALTH_WEIGHTS.auth).toBeGreaterThanOrEqual(HEALTH_WEIGHTS.jobSuccess);
    expect(HEALTH_WEIGHTS.aclRefresh).toBeGreaterThanOrEqual(HEALTH_WEIGHTS.liveLatency);
  });

  it('clamps out-of-range inputs', () => {
    expect(healthScore({ ...healthy, auth: 5 })).toBe(100);   // clamped to 1
    expect(healthScore({ ...healthy, auth: -3 })).toBe(75);   // clamped to 0 → loses auth's 0.25
  });
});

describe('§23 — the planner-facing consumer: health biases fan-out BEFORE Degraded', () => {
  it('a healthy connector keeps the live path', () => {
    expect(livePathBias(healthScore(healthy))).toBe('prefer_live');
  });

  it('a degrading connector biases toward index BEFORE the lifecycle machine reaches Degraded', () => {
    // Auth failing (loses 0.25) + ACL refresh failing (loses 0.20) → 55 < 60.
    const degrading = healthScore({ ...healthy, auth: 0, aclRefresh: 0 });
    expect(degrading).toBeLessThan(PLANNER_INDEX_BIAS_THRESHOLD);
    expect(livePathBias(degrading)).toBe('prefer_index');
  });

  it('biasing is NOT withholding — health biases, lifecycle gates', () => {
    // The bias output is only prefer_live | prefer_index — never "withhold".
    // Withholding is ADR-004 Degraded + ADR-010 decideServing, a stricter path.
    const outputs = [0, 30, 59, 60, 100].map(livePathBias);
    for (const o of outputs) expect(['prefer_live', 'prefer_index']).toContain(o);
  });
});

describe('§23 — SLO table', () => {
  it('latency SLOs are per-profile; Enterprise is strictest', () => {
    const idx = SLO_TABLE.index_path_latency_p95;
    expect(typeof idx.target).toBe('object');
    if (typeof idx.target === 'object') {
      expect(idx.target.enterprise).toBeLessThan(idx.target.starter);
    }
  });

  it('index-path latency breach is profile-sensitive (600ms ok on Starter, breach on Enterprise)', () => {
    expect(evaluateSlo('index_path_latency_p95', 600, 'starter').breached).toBe(false);  // ≤ 800
    expect(evaluateSlo('index_path_latency_p95', 600, 'enterprise').breached).toBe(true); // > 250
  });

  it('rate SLOs use gte: below target is a breach', () => {
    expect(evaluateSlo('semantic_cache_hit_rate', 0.35).breached).toBe(true);   // < 0.40
    expect(evaluateSlo('semantic_cache_hit_rate', 0.45).breached).toBe(false);
    expect(evaluateSlo('critical_livecheck_availability', 0.998).breached).toBe(true); // < 0.999
  });

  it('latency SLOs use lte: above target is a breach', () => {
    expect(evaluateSlo('live_path_latency_p95', 3500).breached).toBe(true);   // > 3000
    expect(evaluateSlo('live_path_latency_p95', 2500).breached).toBe(false);
  });

  it('graph convergence after membership change is bounded at 5 minutes', () => {
    expect(evaluateSlo('graph_convergence_after_membership', 6 * 60 * 1000).breached).toBe(true);
    expect(evaluateSlo('graph_convergence_after_membership', 4 * 60 * 1000).breached).toBe(false);
  });

  it('an override target applies (indexing lag = half class staleness, set at wiring)', () => {
    // Operational class max staleness 900s ⇒ SLO half = 450s.
    expect(evaluateSlo('indexing_lag_operational', 500_000, 'business', 450_000).breached).toBe(true);
    expect(evaluateSlo('indexing_lag_operational', 400_000, 'business', 450_000).breached).toBe(false);
  });
});
