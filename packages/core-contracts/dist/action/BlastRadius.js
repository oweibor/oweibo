"use strict";
/**
 * S.0: BlastRadius — structured estimate of what a plan / action affects,
 * computed *before* execution.
 *
 * Aggregated from per-action `BlastRadiusContribution` by
 * `BlastRadiusComputer.aggregate()`. Used at gate-time to compare against
 * tenant plan-budget ceilings and to surface "what's about to happen"
 * to plan approvers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_BLAST_RADIUS = exports.REVERSIBILITY_RANK = void 0;
exports.REVERSIBILITY_RANK = {
    trivial: 0,
    reversible_with_cost: 1,
    irreversible: 2,
};
/**
 * Zero contributions ⇒ literally zero cost (not unknown). Empty plan has
 * nothing to spend on. Unknown cost only emerges when an individual
 * contribution declares `costUsdCents: null` (the aggregator propagates
 * null when any contribution is unknown).
 */
exports.EMPTY_BLAST_RADIUS = {
    systems: [],
    dataDomains: [],
    worstReversibility: 'trivial',
    estimatedCostUsdCents: 0,
    estimatedReachUserCount: 0,
};
//# sourceMappingURL=BlastRadius.js.map