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
export declare const REVERSIBILITY_RANK: Readonly<Record<Reversibility, number>>;
export interface BlastRadius {
    /** Distinct external systems touched (e.g. ['github','slack','stripe']). */
    readonly systems: readonly string[];
    /** Distinct tenant data domains touched (e.g. ['source_code','user_pii','billing']). */
    readonly dataDomains: readonly string[];
    /** Worst reversibility across the plan — biases toward least reversible. */
    readonly worstReversibility: Reversibility;
    /**
     * Estimated monetary cost in USD cents.
     *
     * Audit-fix (S.0 #9): use `null` (not `0`) when the cost is genuinely
     * unknown — i.e. the action has not been costed and no estimator
     * filled it in. A literal `0` means "this action is free / has been
     * confirmed to cost nothing." S.6's QuotaService treats null as
     * "ask the BudgetEstimator for a conservative p95 fallback" and
     * skips the cost-quota check (with a metric) only when the estimator
     * itself returns null. A literal `0` passes the cost-quota check
     * silently — only set it when the action is truly free.
     */
    readonly estimatedCostUsdCents: number | null;
    /** Estimated user-visible reach: how many end-users could observe this. */
    readonly estimatedReachUserCount: number;
}
/**
 * Per-action contribution to the plan's blast radius. Same shape as
 * BlastRadius (modulo `worstReversibility` → `reversibility`) so the
 * aggregator is a fold over an array of contributions.
 *
 * `costUsdCents: null` carries the same "unknown — defer to estimator"
 * semantics as in BlastRadius; the aggregator returns null for the plan
 * total when ANY contribution is null (unknown poisons the sum).
 */
export interface BlastRadiusContribution {
    readonly systems: readonly string[];
    readonly dataDomains: readonly string[];
    readonly reversibility: Reversibility;
    readonly costUsdCents: number | null;
    readonly reachUserCount: number;
}
/**
 * Zero contributions ⇒ literally zero cost (not unknown). Empty plan has
 * nothing to spend on. Unknown cost only emerges when an individual
 * contribution declares `costUsdCents: null` (the aggregator propagates
 * null when any contribution is unknown).
 */
export declare const EMPTY_BLAST_RADIUS: BlastRadius;
//# sourceMappingURL=BlastRadius.d.ts.map