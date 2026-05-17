// §10.7 — Hypervolume gain computation for the GEPA velocity governor.
//
// Queries oweibo.prompt_versions for a given (role, slot_id) within a date
// window and counts the number of new frontier members that were created
// (Pareto-dominating offspring). This is the "frontier hypervolume gain"
// metric that the velocity tracker uses to classify velocity tiers.

import type { Pool } from 'pg';

/**
 * Raw Pareto score axes stored in prompt_versions.eval_score JSONB.
 * Matches the ParetoScore interface in gepa-core.
 */
interface ParetoScore {
  readonly qualityPassRate:  number;
  readonly qualityScoreMean: number;
  readonly tokensP50:        number;
  readonly tokensP95:        number;
}

/**
 * Check if score `a` Pareto-dominates score `b`.
 * quality axes: higher is better; token axes: lower is better.
 */
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

/**
 * Compute the frontier hypervolume gain for a slot within a date window.
 *
 * "Gain" is defined as the count of new prompt_versions rows created in the
 * window that Pareto-dominate the incumbent (the current stable-v0 pointer).
 * This is a simplified but practical proxy for true hypervolume delta —
 * counting dominating offspring captures whether the optimizer is still
 * making meaningful progress.
 *
 * @param pool      Postgres connection pool
 * @param slotId    The slot to measure
 * @param fromDate  Start of the measurement window (inclusive)
 * @param toDate    End of the measurement window (inclusive)
 * @returns Number of Pareto-dominating offspring in the window
 */
export async function computeHypervolumeGain(
  pool:     Pool,
  slotId:   string,
  fromDate: Date,
  toDate:   Date,
): Promise<number> {
  // 1. Get the incumbent score (current stable-v0 channel pointer)
  const incumbentResult = await pool.query<{ eval_score: string }>(
    `SELECT pv.eval_score
     FROM oweibo.prompt_versions pv
     JOIN oweibo.channels ch ON ch.prompt_hash = pv.hash
     WHERE ch.name = 'stable-v0'
       AND pv.slot_id = $1
     LIMIT 1`,
    [slotId],
  );

  // If no incumbent exists, every offspring counts as a gain
  const incumbentRow = incumbentResult.rows[0];
  let incumbentScore: ParetoScore | null = null;
  if (incumbentRow?.eval_score) {
    try {
      const parsed = typeof incumbentRow.eval_score === 'string'
        ? JSON.parse(incumbentRow.eval_score) as ParetoScore
        : incumbentRow.eval_score as unknown as ParetoScore;
      if (isValidParetoScore(parsed)) {
        incumbentScore = parsed;
      }
    } catch { /* treat as no incumbent */ }
  }

  // 2. Get all offspring created in the window for this slot
  const offspringResult = await pool.query<{ eval_score: string }>(
    `SELECT eval_score
     FROM oweibo.prompt_versions
     WHERE slot_id = $1
       AND created_at >= $2
       AND created_at <= $3
       AND eval_score IS NOT NULL`,
    [slotId, fromDate.toISOString(), toDate.toISOString()],
  );

  if (offspringResult.rows.length === 0) return 0;

  // 3. Count how many offspring Pareto-dominate the incumbent
  let dominatingCount = 0;
  for (const row of offspringResult.rows) {
    try {
      const score = typeof row.eval_score === 'string'
        ? JSON.parse(row.eval_score) as ParetoScore
        : row.eval_score as unknown as ParetoScore;

      if (!isValidParetoScore(score)) continue;

      // If no incumbent, every valid offspring is a "gain"
      if (!incumbentScore) {
        dominatingCount++;
        continue;
      }

      if (paretoDominates(score, incumbentScore)) {
        dominatingCount++;
      }
    } catch { /* skip malformed rows */ }
  }

  return dominatingCount;
}

/**
 * Type guard for ParetoScore — ensures all four axes are present and numeric.
 */
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

// ── Exported for testing ──────────────────────────────────────────────────────
export { paretoDominates, isValidParetoScore };
export type { ParetoScore };
