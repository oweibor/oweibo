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
import type {
  IGoalTemplateMatcher,
  GoalTemplateMatch,
  ISubGoal,
} from '@oweibo/core-contracts';

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

const DEFAULT_THRESHOLD = 0.78;

export class InMemoryGoalTemplateMatcher implements IGoalTemplateMatcher {
  private readonly threshold: number;

  constructor(
    private readonly entries: readonly MatcherTemplateEntry[],
    private readonly embedQuery: QueryEmbedder,
    opts: InMemoryGoalTemplateMatcherOptions = {},
  ) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  }

  async match(goalDescription: string): Promise<GoalTemplateMatch | null> {
    if (this.entries.length === 0) return null;

    const query = await this.embedQuery(goalDescription);
    if (query.length === 0) return null;

    let best: { entry: MatcherTemplateEntry; sim: number } | null = null;
    for (const entry of this.entries) {
      if (entry.triggerEmbedding.length !== query.length) continue;
      const sim = cosineSimilarity(query, entry.triggerEmbedding);
      if (best === null || sim > best.sim) {
        best = { entry, sim };
      }
    }

    if (!best || best.sim < this.threshold) return null;

    return {
      templateId: best.entry.templateId,
      catalogVersion: best.entry.catalogVersion,
      similarity: best.sim,
      subGoalSkeleton: best.entry.subGoalSkeleton,
    };
  }
}

/** Plain cosine similarity. Returns NaN-safe 0 when either norm is 0. */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
