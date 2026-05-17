/**
 * Source channel for a recalled memory entry.
 */
export type RecallSource = 'ltm-agent' | 'ltm-project' | 'ltm-tenant' | 'stm';
/**
 * Score adjustment constants.
 * Mirrors the values in MemoryWarmer — kept in sync here so the pure
 * scorer can be tested in isolation without importing MemoryWarmer.
 */
export declare const SCORE_CONSTANTS: {
    readonly AGENT_BOOST: 0.1;
    readonly PROJECT_BOOST: 0.08;
    readonly STM_BOOST: 0.05;
    readonly STM_SCALE: 0.6;
    readonly STM_OFFSET: 0.25;
};
/**
 * Compute the normalised composite score for a recalled memory entry.
 *
 * @param rawScore   The raw similarity score returned by the vector store (0–1 for LTM).
 *                   For STM entries, this should be the cosine similarity (default 1.0
 *                   when the store does not expose the KNN score).
 * @param source     The recall channel the entry came from.
 */
export declare function computeRecallScore(rawScore: number, source: RecallSource): number;
/**
 * Deduplicate a list of scored entries by their summary text, keeping the
 * highest-scoring occurrence of each summary.
 *
 * Expects the input to be pre-sorted descending by score so that the first
 * occurrence of each summary is always the highest-scored one.
 */
export declare function deduplicateBySummary<T extends {
    summary: string;
    score: number;
}>(entries: T[]): T[];
/**
 * Sort entries descending by score, deduplicate, and slice to topK.
 */
export declare function rankAndSlice<T extends {
    summary: string;
    score: number;
}>(entries: T[], topK: number): T[];
/**
 * Minimum recall score threshold — entries below this are never shown.
 * Used as a quality floor, not configurable per-call.
 */
export declare const MIN_RECALL_SCORE = 0.3;
/**
 * Filter entries below the minimum quality threshold.
 */
export declare function filterByMinScore<T extends {
    score: number;
}>(entries: T[], minScore?: number): T[];
//# sourceMappingURL=MemoryRecallScorer.d.ts.map