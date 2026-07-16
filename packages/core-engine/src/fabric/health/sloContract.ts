/**
 * K.9 / arch §23 — Service Level Objectives, wired to the §23 table.
 *
 * §23 is explicit that these are "initial defaults requiring calibration
 * against production telemetry, not committed numbers" (consistent with §9.1's
 * confidence weights). This module encodes the table and the DERIVATION rule
 * each row states — an SLO measurement compares an observed value against the
 * profile-appropriate target and reports breach/ok, so alerting has a single
 * source of truth rather than thresholds scattered across dashboards.
 */

export type DeploymentProfile = 'starter' | 'business' | 'enterprise';

export type SloId =
  | 'index_path_latency_p95'
  | 'live_path_latency_p95'
  | 'indexing_lag_operational'
  | 'indexing_lag_transactional'
  | 'critical_livecheck_availability'
  | 'identity_resolution_convergence'
  | 'graph_convergence_after_membership'
  | 'semantic_cache_hit_rate'
  | 'connector_silence_to_suspend';

export type Comparator = 'lte' | 'gte';

export interface SloTarget {
  readonly id: SloId;
  /** 'lte' — observed must be ≤ target (latencies, lag); 'gte' — ≥ (rates). */
  readonly comparator: Comparator;
  /** Per-profile target, or a single number when profile-independent. */
  readonly target: number | Readonly<Record<DeploymentProfile, number>>;
  readonly unit: string;
}

/**
 * The §23 table, verbatim in intent. Latency targets are per-profile (§19.1:
 * infrastructure capability differs by profile, so one global number would be
 * unachievable on Starter or unambitious on Enterprise). The rest are
 * profile-independent because their derivation (§5.2 staleness, §6.5 membership,
 * §7.7 cache) is not profile-scoped.
 */
export const SLO_TABLE: Readonly<Record<SloId, SloTarget>> = {
  index_path_latency_p95: {
    id: 'index_path_latency_p95', comparator: 'lte', unit: 'ms',
    target: { starter: 800, business: 500, enterprise: 250 },
  },
  live_path_latency_p95: {
    id: 'live_path_latency_p95', comparator: 'lte', unit: 'ms', target: 3000,
  },
  indexing_lag_operational: {
    // ≤ half the class's max staleness (§5.2): an SLO tighter than the
    // correctness bound it backs, or jitter breaches the guarantee.
    id: 'indexing_lag_operational', comparator: 'lte', unit: 'ms', target: 0, // set per class-staleness at wiring
  },
  indexing_lag_transactional: {
    id: 'indexing_lag_transactional', comparator: 'lte', unit: 'ms', target: 0,
  },
  critical_livecheck_availability: {
    // 99.9% of queries resolve WITHOUT hitting §6.6 withholding.
    id: 'critical_livecheck_availability', comparator: 'gte', unit: 'ratio', target: 0.999,
  },
  identity_resolution_convergence: {
    // Provisional → Resolved/Unresolved within 24h of review-queue entry.
    id: 'identity_resolution_convergence', comparator: 'lte', unit: 'ms', target: 24 * 3600 * 1000,
  },
  graph_convergence_after_membership: {
    // ≤ 5 minutes to affected edges (the graph-side analogue of §6.4 ACL refresh).
    id: 'graph_convergence_after_membership', comparator: 'lte', unit: 'ms', target: 5 * 60 * 1000,
  },
  semantic_cache_hit_rate: {
    // ≥ 40% of eligible (non-Critical) traffic.
    id: 'semantic_cache_hit_rate', comparator: 'gte', unit: 'ratio', target: 0.40,
  },
  connector_silence_to_suspend: {
    // Matches each connector's declared heartbeat interval (§7.7) — set per
    // connector at wiring; the default mirrors the 300s heartbeat.
    id: 'connector_silence_to_suspend', comparator: 'lte', unit: 'ms', target: 300 * 1000,
  },
};

export interface SloEvaluation {
  readonly id: SloId;
  readonly observed: number;
  readonly target: number;
  readonly breached: boolean;
}

function targetFor(t: SloTarget, profile: DeploymentProfile): number {
  return typeof t.target === 'number' ? t.target : t.target[profile];
}

/**
 * Evaluate one SLO. `overrideTarget` lets a wiring site supply the class- or
 * connector-specific value (indexing lag = half staleness; silence = heartbeat)
 * that the table marks as set-at-wiring.
 */
export function evaluateSlo(
  id: SloId,
  observed: number,
  profile: DeploymentProfile = 'business',
  overrideTarget?: number,
): SloEvaluation {
  const t = SLO_TABLE[id];
  const target = overrideTarget ?? targetFor(t, profile);
  const breached = t.comparator === 'lte' ? observed > target : observed < target;
  return { id, observed, target, breached };
}
