/**
 * T.4: PlatformLessonRecall — DB-backed implementation of
 * IPlatformLessonRecall.
 *
 * Reads from oweibo.platform_lessons through the K-anonymity-gated
 * oweibo.releasable_buckets view: only bucket_keys that already have
 * ≥ 5 distinct tenant contributors are surfaced. The recall path is
 * deliberately conservative — it doesn't compute new embeddings (yet);
 * matching is a lexical contains/overlap against the abstract_pattern,
 * with cosine similarity reserved for a future enhancement once we have
 * an embedding column on platform_lessons.
 *
 * Defense in depth: every returned hit is re-passed through applyDLPFilter
 * at read time, so a rule added after the lesson was aggregated still
 * filters it out. Failures audit-log without throwing — recall must never
 * crash the warmer.
 *
 * Audit: every call writes an audit_log row 'memory.platform_lesson.recall'
 * with { query_hash, hits_returned, bucket_keys } so a tenant can later
 * ask "what generic content was injected into my prompts?" The raw query
 * is NOT stored — only its SHA-256 hash.
 */
import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  IPlatformLessonRecall,
  PlatformLessonHit,
  PlatformLessonRecallQuery,
} from '@oweibo/core-contracts';
import { applyDLPFilter } from '../../distillation/LessonDLPFilter.js';

export interface PlatformLessonRecallOptions {
  /** Hard cap on rows scanned per query. Default 200. */
  scanLimit?: number;
  /** topK default when caller omits it. Default 4. */
  defaultTopK?: number;
  /**
   * Optional audit sink. The runtime wires appendAudit from @oweibo/db.
   * When undefined, audit is a no-op (useful for tests).
   */
  audit?: (row: AuditRow) => Promise<void>;
}

export interface AuditRow {
  readonly action: 'memory.platform_lesson.recall';
  readonly details: {
    readonly query_hash: string;
    readonly hits_returned: number;
    readonly bucket_keys: readonly string[];
    readonly role?: string;
    readonly slot_id?: string;
  };
}

const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_TOPK = 4;

export class PlatformLessonRecall implements IPlatformLessonRecall {
  private readonly scanLimit: number;
  private readonly defaultTopK: number;
  private readonly audit: NonNullable<PlatformLessonRecallOptions['audit']>;

  constructor(private readonly pool: Pool, opts: PlatformLessonRecallOptions = {}) {
    this.scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this.defaultTopK = opts.defaultTopK ?? DEFAULT_TOPK;
    this.audit = opts.audit ?? (async () => undefined);
  }

  async recall(q: PlatformLessonRecallQuery): Promise<readonly PlatformLessonHit[]> {
    const topK = Math.max(1, Math.min(q.topK ?? this.defaultTopK, 20));
    const queryHash = createHash('sha256').update(q.query).digest('hex');

    const client = await this.pool.connect();
    let hits: PlatformLessonHit[];
    try {
      hits = await this.queryLessons(client, q, topK);
    } catch {
      hits = [];
    } finally {
      client.release();
    }

    // Re-apply DLP at read time (defense in depth) — drop any hit that
    // fails the current rules even if it passed at aggregation time.
    const filtered = hits.filter((h) => {
      const text = `${h.summary}\n${h.body ?? ''}`;
      return applyDLPFilter(text).pass;
    });

    // Audit — fire and forget; never blocks recall.
    void this.audit({
      action: 'memory.platform_lesson.recall',
      details: {
        query_hash: queryHash,
        hits_returned: filtered.length,
        bucket_keys: filtered.map((h) => h.bucketKey),
        ...(q.role ? { role: q.role } : {}),
        ...(q.slotId ? { slot_id: q.slotId } : {}),
      },
    }).catch(() => undefined);

    return filtered;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async queryLessons(
    client: PoolClient,
    q: PlatformLessonRecallQuery,
    topK: number,
  ): Promise<PlatformLessonHit[]> {
    // Only released buckets are surfaced. The JOIN with releasable_buckets
    // enforces the K-anonymity gate at the SQL layer; we never see a row
    // whose bucket has < 5 contributors.
    const params: unknown[] = [];
    let where = '1=1';
    if (q.role) {
      params.push(q.role);
      where += ` AND pl.role = $${params.length}`;
    }
    if (q.slotId) {
      params.push(q.slotId);
      where += ` AND pl.slot_id = $${params.length}`;
    }
    // T.8: region gate. NULL home_region rows are region-neutral fallback
    // (pre-T.8 / platform curated) and always reachable; otherwise the
    // lesson's region must equal the caller's home_region. When the caller
    // omits homeRegion the filter is skipped — used for cross-region intake
    // override and for legacy callers that haven't been region-aware-wired.
    if (q.homeRegion) {
      params.push(q.homeRegion);
      where += ` AND (pl.home_region IS NULL OR pl.home_region = $${params.length})`;
    }
    params.push(this.scanLimit);
    const result = await client.query<{
      summary: string;
      body: string | null;
      bucket_key: string;
      tenant_count: number;
      confidence: string;
    }>(
      `SELECT
         pl.abstract_pattern AS summary,
         NULL::text AS body,
         pl.bucket_key,
         rb.tenant_count::int AS tenant_count,
         pl.confidence::text  AS confidence
       FROM oweibo.platform_lessons pl
       JOIN oweibo.releasable_buckets rb USING (bucket_key)
       WHERE ${where}
       ORDER BY pl.confidence DESC, pl.aggregated_at DESC
       LIMIT $${params.length}`,
      params,
    );

    // Lexical match score: count of overlapping tokens between the query
    // and the abstract_pattern, normalised to [0, 1]. Reserved future
    // enhancement: cosine similarity once platform_lessons gets an
    // embedding column.
    const queryTokens = tokenise(q.query);
    if (queryTokens.size === 0) return [];

    const scored: PlatformLessonHit[] = [];
    for (const row of result.rows) {
      const patternTokens = tokenise(row.summary);
      const overlap = countOverlap(queryTokens, patternTokens);
      const denom = Math.max(queryTokens.size, patternTokens.size);
      if (denom === 0) continue;
      const score = overlap / denom;
      if (score === 0) continue;
      scored.push({
        summary: row.summary,
        ...(row.body !== null ? { body: row.body } : {}),
        bucketKey: row.bucket_key,
        contributorCount: row.tenant_count,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function tokenise(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const tok of a) if (b.has(tok)) n += 1;
  return n;
}
