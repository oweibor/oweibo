"use strict";
// DONE: Phase A.11 — deterministic memory recall composite scorer.
// Extracted from MemoryWarmer score-normalisation logic.
// Pure functions only — zero LLM calls, zero I/O.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_RECALL_SCORE = exports.SCORE_CONSTANTS = void 0;
exports.computeRecallScore = computeRecallScore;
exports.deduplicateBySummary = deduplicateBySummary;
exports.rankAndSlice = rankAndSlice;
exports.filterByMinScore = filterByMinScore;
/**
 * Score adjustment constants.
 * Mirrors the values in MemoryWarmer — kept in sync here so the pure
 * scorer can be tested in isolation without importing MemoryWarmer.
 */
exports.SCORE_CONSTANTS = {
    AGENT_BOOST: 0.10,
    PROJECT_BOOST: 0.08,
    STM_BOOST: 0.05,
    STM_SCALE: 0.60,
    STM_OFFSET: 0.25,
};
/**
 * Compute the normalised composite score for a recalled memory entry.
 *
 * @param rawScore   The raw similarity score returned by the vector store (0–1 for LTM).
 *                   For STM entries, this should be the cosine similarity (default 1.0
 *                   when the store does not expose the KNN score).
 * @param source     The recall channel the entry came from.
 */
function computeRecallScore(rawScore, source) {
    switch (source) {
        case 'ltm-agent': return rawScore + exports.SCORE_CONSTANTS.AGENT_BOOST;
        case 'ltm-project': return rawScore + exports.SCORE_CONSTANTS.PROJECT_BOOST;
        case 'ltm-tenant': return rawScore;
        case 'stm':
            return exports.SCORE_CONSTANTS.STM_SCALE * rawScore +
                exports.SCORE_CONSTANTS.STM_OFFSET +
                exports.SCORE_CONSTANTS.STM_BOOST;
    }
}
/**
 * Deduplicate a list of scored entries by their summary text, keeping the
 * highest-scoring occurrence of each summary.
 *
 * Expects the input to be pre-sorted descending by score so that the first
 * occurrence of each summary is always the highest-scored one.
 */
function deduplicateBySummary(entries) {
    const seen = new Set();
    return entries.filter(e => {
        if (seen.has(e.summary))
            return false;
        seen.add(e.summary);
        return true;
    });
}
/**
 * Sort entries descending by score, deduplicate, and slice to topK.
 */
function rankAndSlice(entries, topK) {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    return deduplicateBySummary(sorted).slice(0, topK);
}
/**
 * Minimum recall score threshold — entries below this are never shown.
 * Used as a quality floor, not configurable per-call.
 */
exports.MIN_RECALL_SCORE = 0.30;
/**
 * Filter entries below the minimum quality threshold.
 */
function filterByMinScore(entries, minScore = exports.MIN_RECALL_SCORE) {
    return entries.filter(e => e.score >= minScore);
}
//# sourceMappingURL=MemoryRecallScorer.js.map