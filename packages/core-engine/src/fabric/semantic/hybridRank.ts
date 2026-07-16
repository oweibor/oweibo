/**
 * K.5 — Hybrid ranking v1 (arch §4.6, §7.7). Fuses four ranking signals into
 * one score: lexical (FTS), vector (semantic cosine), recency, and
 * source-authority. Graph proximity (K.8) is accepted ADDITIVELY — its
 * weight is present and defaults to 0, so K.8 turns it on without reshaping
 * the interface or re-weighting the others.
 *
 * Ranking is a PURE function of already-ACL-filtered candidates: INV-2
 * (ranking never precedes ACL filtering) is the caller's contract — this
 * module never sees an unauthorized candidate. It only re-orders what
 * retrieval already permitted.
 */

export type RankSignal = 'lexical' | 'vector' | 'recency' | 'sourceAuthority' | 'graphProximity';

/**
 * Weights per signal. Must be non-negative; the ranker normalizes by their
 * sum, so they need not total 1. `graphProximity` defaults to 0 (K.8 arms it).
 */
export type HybridWeights = Readonly<Record<RankSignal, number>>;

export const DEFAULT_HYBRID_WEIGHTS: HybridWeights = {
  lexical: 0.35,
  vector: 0.4,
  recency: 0.15,
  sourceAuthority: 0.1,
  graphProximity: 0, // additive — K.8 sets this without touching the others
};

/** Per-source authority in [0,1] (§4.6). Unknown sources default to 0.5. */
export type SourceAuthority = Readonly<Record<string, number>>;

export interface RankInput {
  readonly candidateId: string;
  /** Raw lexical relevance (e.g. Postgres ts_rank); normalized within the set. */
  readonly lexical: number;
  /** Semantic cosine in [0,1]; 0 when the candidate had no vector hit. */
  readonly vector: number;
  /** When the candidate's indexed copy was last updated (ms epoch). */
  readonly updatedAtMs: number;
  readonly source: string;
  /** Graph proximity in [0,1]; 0 until K.8. */
  readonly graphProximity?: number;
}

export interface RankedCandidate {
  readonly candidateId: string;
  readonly score: number;
  readonly signals: Readonly<Record<RankSignal, number>>;
}

export interface HybridRankOptions {
  readonly weights?: HybridWeights;
  readonly sourceAuthority?: SourceAuthority;
  /** Recency half-life in ms (default 14 days, matching the memory store). */
  readonly recencyHalfLifeMs?: number;
  readonly nowMs?: number;
}

const DAY_MS = 86_400_000;

/**
 * Rank candidates by the fused hybrid score, descending. Lexical scores are
 * min-max normalized within the candidate set (ts_rank is unbounded and
 * corpus-relative); vector/recency/sourceAuthority/graphProximity are already
 * in [0,1]. The final score is the weight-normalized convex combination, so
 * it too lands in [0,1] and is comparable across queries.
 */
export function hybridRank(candidates: readonly RankInput[], opts: HybridRankOptions = {}): RankedCandidate[] {
  const weights = opts.weights ?? DEFAULT_HYBRID_WEIGHTS;
  const authority = opts.sourceAuthority ?? {};
  const halfLife = opts.recencyHalfLifeMs ?? 14 * DAY_MS;
  const now = opts.nowMs ?? Date.now();

  const weightSum = (Object.values(weights) as number[]).reduce((a, b) => a + b, 0) || 1;
  const maxLex = Math.max(0, ...candidates.map((c) => c.lexical));

  const ranked = candidates.map((c) => {
    const lexical = maxLex > 0 ? c.lexical / maxLex : 0;
    const vector = clamp01(c.vector);
    const recency = Math.exp(-Math.max(0, now - c.updatedAtMs) / halfLife);
    const sourceAuthority = clamp01(authority[c.source] ?? 0.5);
    const graphProximity = clamp01(c.graphProximity ?? 0);

    const signals: Record<RankSignal, number> = { lexical, vector, recency, sourceAuthority, graphProximity };
    const score =
      (weights.lexical * lexical +
        weights.vector * vector +
        weights.recency * recency +
        weights.sourceAuthority * sourceAuthority +
        weights.graphProximity * graphProximity) /
      weightSum;

    return { candidateId: c.candidateId, score, signals };
  });

  return ranked.sort((a, b) => b.score - a.score);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
