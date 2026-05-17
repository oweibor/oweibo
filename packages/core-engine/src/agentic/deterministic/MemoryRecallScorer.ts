// DONE: Phase A.11 — deterministic memory recall composite scorer.
// Extracted from MemoryWarmer score-normalisation logic.
// Pure functions only — zero LLM calls, zero I/O.

/**
 * Source channel for a recalled memory entry.
 */
export type RecallSource = 'ltm-agent' | 'ltm-project' | 'ltm-tenant' | 'stm';

/**
 * Score adjustment constants.
 * Mirrors the values in MemoryWarmer — kept in sync here so the pure
 * scorer can be tested in isolation without importing MemoryWarmer.
 */
export const SCORE_CONSTANTS = {
  AGENT_BOOST:   0.10,
  PROJECT_BOOST: 0.08,
  STM_BOOST:     0.05,
  STM_SCALE:     0.60,
  STM_OFFSET:    0.25,
} as const;

/**
 * Compute the normalised composite score for a recalled memory entry.
 *
 * @param rawScore   The raw similarity score returned by the vector store (0–1 for LTM).
 *                   For STM entries, this should be the cosine similarity (default 1.0
 *                   when the store does not expose the KNN score).
 * @param source     The recall channel the entry came from.
 */
export function computeRecallScore(rawScore: number, source: RecallSource): number {
  switch (source) {
    case 'ltm-agent':   return rawScore + SCORE_CONSTANTS.AGENT_BOOST;
    case 'ltm-project': return rawScore + SCORE_CONSTANTS.PROJECT_BOOST;
    case 'ltm-tenant':  return rawScore;
    case 'stm':
      return SCORE_CONSTANTS.STM_SCALE * rawScore +
             SCORE_CONSTANTS.STM_OFFSET +
             SCORE_CONSTANTS.STM_BOOST;
  }
}

/**
 * Deduplicate a list of scored entries by their summary text, keeping the
 * highest-scoring occurrence of each summary.
 *
 * Expects the input to be pre-sorted descending by score so that the first
 * occurrence of each summary is always the highest-scored one.
 */
export function deduplicateBySummary<T extends { summary: string; score: number }>(
  entries: T[],
): T[] {
  const seen = new Set<string>();
  return entries.filter(e => {
    if (seen.has(e.summary)) return false;
    seen.add(e.summary);
    return true;
  });
}

/**
 * Sort entries descending by score, deduplicate, and slice to topK.
 */
export function rankAndSlice<T extends { summary: string; score: number }>(
  entries: T[],
  topK:    number,
): T[] {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  return deduplicateBySummary(sorted).slice(0, topK);
}

/**
 * Minimum recall score threshold — entries below this are never shown.
 * Used as a quality floor, not configurable per-call.
 */
export const MIN_RECALL_SCORE = 0.30;

/**
 * Filter entries below the minimum quality threshold.
 */
export function filterByMinScore<T extends { score: number }>(
  entries: T[],
  minScore = MIN_RECALL_SCORE,
): T[] {
  return entries.filter(e => e.score >= minScore);
}
