export interface FrontierMember {
    readonly hash: string;
    readonly embedding: number[];
    readonly evalScores: {
        qualityPassRate: number;
        qualityScoreMean: number;
        tokensP50: number;
    };
}
/** Cosine similarity between two equal-length vectors. */
export declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * Compute mean pairwise cosine similarity across all frontier members.
 * High value → low diversity.
 */
export declare function frontierMeanPairwiseSimilarity(members: readonly FrontierMember[]): number;
/**
 * Mean pairwise cosine *distance* (1 - similarity).
 * Higher = more diverse.
 */
export declare function frontierMeanPairwiseDistance(members: readonly FrontierMember[]): number;
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
export declare function evictLowNoveltyMembers(members: readonly FrontierMember[], threshold?: number): FrontierMember[];
//# sourceMappingURL=LinguisticDiversityFloor.d.ts.map