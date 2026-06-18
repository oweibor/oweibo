/**
 * T.4: IPlatformLessonRecall — the consumer-side counterpart to the
 * pattern-bank contributor path.
 *
 * Implementations read pre-anonymised lessons from oweibo.platform_lessons
 * (gated by the K-anonymity ≥ 5 view oweibo.releasable_buckets) and return
 * hits that match the agent's query. The contract intentionally does not
 * take a tenantId — these lessons are platform-wide and cross-tenant by
 * construction. Callers must not re-attribute them.
 *
 * A per-tenant feature flag in the runtime decides whether
 * MemoryWarmer adds a platform-lesson recall channel; the contract is
 * stable regardless of how the flag is wired.
 */

export interface PlatformLessonHit {
  /** The anonymised lesson summary. */
  readonly summary: string;
  /** Optional longer body. */
  readonly body?: string;
  /** Bucket key from PatternAggregator (role:slotId:errorClass). */
  readonly bucketKey: string;
  /** K-anonymity contributor count — at least 5 (guaranteed by the view). */
  readonly contributorCount: number;
  /** Cosine similarity to query in [0, 1]. */
  readonly score: number;
}

export interface PlatformLessonRecallQuery {
  readonly query: string;
  readonly role?: string;
  readonly slotId?: string;
  readonly topK?: number;
  /**
   * T.8: the calling tenant's canonical home_region (e.g. `us-east-1`).
   * When present, the WHERE clause restricts to `home_region = $X OR
   * home_region IS NULL` — region-neutral lessons (pre-T.8 / platform
   * curated) are always reachable; cross-region lessons are not. When
   * absent the filter is skipped, matching the pre-T.8 behaviour. This
   * field is NOT a tenant identifier — it is a coarse geographic bucket
   * shared by many tenants and safe to log.
   */
  readonly homeRegion?: string;
}

export interface IPlatformLessonRecall {
  /**
   * Recall lessons matching the query. Does NOT take a tenantId — platform
   * lessons are pre-anonymised and shared. Implementations should:
   *   - filter to released (K ≥ 5) buckets
   *   - re-apply DLP at read time (defense in depth)
   *   - audit every call
   */
  recall(query: PlatformLessonRecallQuery): Promise<readonly PlatformLessonHit[]>;
}
