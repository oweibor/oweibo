export type TaskOutcomeForNovelty = {
    readonly outcome: 'success' | 'failure' | 'recovery';
    readonly errorClass?: string;
    readonly toolSequence?: readonly string[];
    readonly subgoalCount?: number;
};
export interface NoveltyContext {
    /** Set of errorClass strings already seen for this tenant. */
    readonly seenErrorClasses: ReadonlySet<string>;
    /** Set of canonicalised tool-sequence fingerprints seen for this tenant. */
    readonly seenToolFingerprints: ReadonlySet<string>;
}
export interface NoveltyDecision {
    readonly novel: boolean;
    readonly reason: string;
}
/**
 * Fingerprint a tool sequence for deduplication.
 * Collapses runs of the same tool into one entry to avoid trivially-different sequences.
 */
export declare function fingerprintToolSequence(tools: readonly string[]): string;
/**
 * Classify whether a task result is novel enough to warrant distillation.
 *
 * Returns novel=true for:
 *   1. Any 'recovery' outcome (agent recovered from failure — high signal).
 *   2. A 'failure' with an unseen errorClass.
 *   3. A 'success' with an unseen tool-sequence fingerprint.
 *   4. A 'success' with subgoalCount > 8 (complex task, rarer signal).
 */
export declare function classifyNovelty(task: TaskOutcomeForNovelty, context: NoveltyContext): NoveltyDecision;
//# sourceMappingURL=NoveltyClassifier.d.ts.map