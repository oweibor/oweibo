// DONE: Phase C.3a-i — LinguisticDiversityFloor.
// Evicts near-duplicate offspring from the Pareto frontier.
// Exit criterion: synthetic test with 5 near-duplicate offspring evicts ≥4.
/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/**
 * Compute mean pairwise cosine similarity across all frontier members.
 * High value → low diversity.
 */
export function frontierMeanPairwiseSimilarity(members) {
    if (members.length < 2)
        return 0;
    let total = 0;
    let count = 0;
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            total += cosineSimilarity(members[i].embedding, members[j].embedding);
            count++;
        }
    }
    return count > 0 ? total / count : 0;
}
/**
 * Mean pairwise cosine *distance* (1 - similarity).
 * Higher = more diverse.
 */
export function frontierMeanPairwiseDistance(members) {
    return 1 - frontierMeanPairwiseSimilarity(members);
}
/**
 * Evict members that are too similar to an already-accepted member.
 *
 * Algorithm: greedy sequential scan. For each candidate (sorted by eval score desc),
 * accept if it is sufficiently dissimilar to all already-accepted members.
 *
 * @param members   Frontier members (order determines priority when ties occur).
 * @param threshold Cosine similarity above which a candidate is "too similar" (default 0.85).
 * @returns         Filtered frontier with low-novelty members removed.
 */
export function evictLowNoveltyMembers(members, threshold = 0.85) {
    // Sort descending by quality pass rate, then quality score
    const sorted = [...members].sort((a, b) => b.evalScores.qualityPassRate - a.evalScores.qualityPassRate ||
        b.evalScores.qualityScoreMean - a.evalScores.qualityScoreMean);
    const accepted = [];
    for (const candidate of sorted) {
        const tooSimilar = accepted.some(a => cosineSimilarity(a.embedding, candidate.embedding) >= threshold);
        if (!tooSimilar)
            accepted.push(candidate);
    }
    return accepted;
}
//# sourceMappingURL=LinguisticDiversityFloor.js.map