/**
 * S.0: BlastRadiusComputer — folds per-action `BlastRadiusContribution[]`
 * into a single aggregated `BlastRadius`.
 *
 * Aggregation rules:
 *   - systems / dataDomains: set-union (deduplicated, sorted for stable output)
 *   - worstReversibility: max by REVERSIBILITY_RANK (least-reversible wins)
 *   - estimatedCostUsdCents: sum, clamped non-negative
 *   - estimatedReachUserCount: max (not sum — same end-user observing two
 *     actions is still one observation)
 *
 * Pure / synchronous so it can be called inside a gate decision without DB.
 */
import type {
  BlastRadius,
  BlastRadiusContribution,
  Reversibility,
} from '@oweibo/core-contracts';
import { EMPTY_BLAST_RADIUS, REVERSIBILITY_RANK } from '@oweibo/core-contracts';

export class BlastRadiusComputer {
  static aggregate(contributions: readonly BlastRadiusContribution[]): BlastRadius {
    if (contributions.length === 0) return EMPTY_BLAST_RADIUS;

    const systems = new Set<string>();
    const domains = new Set<string>();
    let worstRank = REVERSIBILITY_RANK.trivial;
    let cost = 0;
    let reach = 0;

    for (const c of contributions) {
      for (const s of c.systems) systems.add(s);
      for (const d of c.dataDomains) domains.add(d);
      const rank = REVERSIBILITY_RANK[c.reversibility];
      if (rank > worstRank) worstRank = rank;
      cost += Math.max(0, c.costUsdCents);
      if (c.reachUserCount > reach) reach = c.reachUserCount;
    }

    return {
      systems: Array.from(systems).sort(),
      dataDomains: Array.from(domains).sort(),
      worstReversibility: rankToReversibility(worstRank),
      estimatedCostUsdCents: cost,
      estimatedReachUserCount: reach,
    };
  }
}

function rankToReversibility(rank: number): Reversibility {
  for (const [k, v] of Object.entries(REVERSIBILITY_RANK) as Array<[Reversibility, number]>) {
    if (v === rank) return k;
  }
  return 'irreversible';
}
