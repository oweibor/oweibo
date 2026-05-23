/**
 * S.0: BlastRadius — structured estimate of what a plan / action affects,
 * computed *before* execution.
 *
 * Aggregated from per-action `BlastRadiusContribution` by
 * `BlastRadiusComputer.aggregate()`. Used at gate-time to compare against
 * tenant plan-budget ceilings and to surface "what's about to happen"
 * to plan approvers.
 */

/** Reversibility coarse-bucketing — `worst_*` aggregations bias toward least-reversible. */
export type Reversibility = 'trivial' | 'reversible_with_cost' | 'irreversible';

export const REVERSIBILITY_RANK: Readonly<Record<Reversibility, number>> = {
  trivial: 0,
  reversible_with_cost: 1,
  irreversible: 2,
};

export interface BlastRadius {
  /** Distinct external systems touched (e.g. ['github','slack','stripe']). */
  readonly systems: readonly string[];
  /** Distinct tenant data domains touched (e.g. ['source_code','user_pii','billing']). */
  readonly dataDomains: readonly string[];
  /** Worst reversibility across the plan — biases toward least reversible. */
  readonly worstReversibility: Reversibility;
  /** Estimated monetary cost in USD cents (0 if unknown). */
  readonly estimatedCostUsdCents: number;
  /** Estimated user-visible reach: how many end-users could observe this. */
  readonly estimatedReachUserCount: number;
}

/**
 * Per-action contribution to the plan's blast radius. Same shape as
 * BlastRadius (modulo `worstReversibility` → `reversibility`) so the
 * aggregator is a fold over an array of contributions.
 */
export interface BlastRadiusContribution {
  readonly systems: readonly string[];
  readonly dataDomains: readonly string[];
  readonly reversibility: Reversibility;
  readonly costUsdCents: number;
  readonly reachUserCount: number;
}

export const EMPTY_BLAST_RADIUS: BlastRadius = {
  systems: [],
  dataDomains: [],
  worstReversibility: 'trivial',
  estimatedCostUsdCents: 0,
  estimatedReachUserCount: 0,
};
