/** Minimum similarity threshold to flag as regurgitation (default 0.85). */
export declare const DEFAULT_REGURGITATION_THRESHOLD = 0.85;
/**
 * Compute the maximum similarity between a mutation candidate and any lesson
 * in the lesson sample. Lesson embeddings can be pre-computed and passed in
 * as BOW maps for efficiency.
 *
 * @param mutationText    The proposed slot mutation text.
 * @param recentLessons   The ~20 lessons the reflection LLM was shown.
 * @returns               Maximum cosine similarity (0-1).
 */
export declare function maxSimilarity(mutationText: string, recentLessons: readonly string[]): number;
export interface RegurgitationResult {
    readonly regurgitated: boolean;
    readonly maxSim: number;
    readonly threshold: number;
}
/**
 * Classify whether a mutation text is a regurgitation of a lesson.
 */
export declare function detectRegurgitation(mutationText: string, recentLessons: readonly string[], threshold?: number): RegurgitationResult;
//# sourceMappingURL=RegurgitationDetector.d.ts.map