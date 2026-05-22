/**
 * T.2.d: InMemoryGoalTemplateMatcher — IGoalTemplateMatcher implementation
 * that holds the catalog + a precomputed embedding per template in process
 * memory and runs cosine similarity at match time.
 *
 * Used by tests (catalog held as fixtures) and by the runtime path when
 * pgvector is unavailable and the matcher service has materialised the
 * catalog into memory at startup. The pgvector-backed DB matcher will
 * land in T.2.d.runtime when the loader script is written; T.2.d itself
 * delivers the contract + in-memory impl that GoalDecomposer consumes.
 *
 * Embedding convention: 1536-dimensional Float32 unit-norm vector.
 * Cosine reduces to a dot product since both vectors are unit-norm.
 * Tests use shorter vectors; the impl tolerates any positive dim.
 */
import type { IGoalTemplateMatcher, GoalTemplateMatch, ISubGoal } from '@oweibo/core-contracts';
export interface MatcherTemplateEntry {
    readonly templateId: string;
    readonly catalogVersion: string;
    readonly triggerSummary: string;
    readonly triggerEmbedding: ReadonlyArray<number>;
    readonly subGoalSkeleton: readonly ISubGoal[];
}
/** Function that embeds a query string. Tests pass an in-memory map. */
export type QueryEmbedder = (text: string) => Promise<ReadonlyArray<number>>;
export interface InMemoryGoalTemplateMatcherOptions {
    /** Minimum cosine similarity for a match to be returned. Default 0.78. */
    threshold?: number;
}
export declare class InMemoryGoalTemplateMatcher implements IGoalTemplateMatcher {
    private readonly entries;
    private readonly embedQuery;
    private readonly threshold;
    constructor(entries: readonly MatcherTemplateEntry[], embedQuery: QueryEmbedder, opts?: InMemoryGoalTemplateMatcherOptions);
    match(goalDescription: string): Promise<GoalTemplateMatch | null>;
}
/** Plain cosine similarity. Returns NaN-safe 0 when either norm is 0. */
export declare function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number;
//# sourceMappingURL=InMemoryGoalTemplateMatcher.d.ts.map