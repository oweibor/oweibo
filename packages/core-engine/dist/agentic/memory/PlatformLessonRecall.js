"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlatformLessonRecall = void 0;
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
const crypto_1 = require("crypto");
const LessonDLPFilter_js_1 = require("../../distillation/LessonDLPFilter.js");
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_TOPK = 4;
class PlatformLessonRecall {
    pool;
    scanLimit;
    defaultTopK;
    audit;
    constructor(pool, opts = {}) {
        this.pool = pool;
        this.scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
        this.defaultTopK = opts.defaultTopK ?? DEFAULT_TOPK;
        this.audit = opts.audit ?? (async () => undefined);
    }
    async recall(q) {
        const topK = Math.max(1, Math.min(q.topK ?? this.defaultTopK, 20));
        const queryHash = (0, crypto_1.createHash)('sha256').update(q.query).digest('hex');
        const client = await this.pool.connect();
        let hits;
        try {
            hits = await this.queryLessons(client, q, topK);
        }
        catch {
            hits = [];
        }
        finally {
            client.release();
        }
        // Re-apply DLP at read time (defense in depth) — drop any hit that
        // fails the current rules even if it passed at aggregation time.
        const filtered = hits.filter((h) => {
            const text = `${h.summary}\n${h.body ?? ''}`;
            return (0, LessonDLPFilter_js_1.applyDLPFilter)(text).pass;
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
    async queryLessons(client, q, topK) {
        // Only released buckets are surfaced. The JOIN with releasable_buckets
        // enforces the K-anonymity gate at the SQL layer; we never see a row
        // whose bucket has < 5 contributors.
        const params = [];
        let where = '1=1';
        if (q.role) {
            params.push(q.role);
            where += ` AND pl.role = $${params.length}`;
        }
        if (q.slotId) {
            params.push(q.slotId);
            where += ` AND pl.slot_id = $${params.length}`;
        }
        params.push(this.scanLimit);
        const result = await client.query(`SELECT
         pl.abstract_pattern AS summary,
         NULL::text AS body,
         pl.bucket_key,
         rb.tenant_count::int AS tenant_count,
         pl.confidence::text  AS confidence
       FROM oweibo.platform_lessons pl
       JOIN oweibo.releasable_buckets rb USING (bucket_key)
       WHERE ${where}
       ORDER BY pl.confidence DESC, pl.aggregated_at DESC
       LIMIT $${params.length}`, params);
        // Lexical match score: count of overlapping tokens between the query
        // and the abstract_pattern, normalised to [0, 1]. Reserved future
        // enhancement: cosine similarity once platform_lessons gets an
        // embedding column.
        const queryTokens = tokenise(q.query);
        if (queryTokens.size === 0)
            return [];
        const scored = [];
        for (const row of result.rows) {
            const patternTokens = tokenise(row.summary);
            const overlap = countOverlap(queryTokens, patternTokens);
            const denom = Math.max(queryTokens.size, patternTokens.size);
            if (denom === 0)
                continue;
            const score = overlap / denom;
            if (score === 0)
                continue;
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
exports.PlatformLessonRecall = PlatformLessonRecall;
// ── Helpers ───────────────────────────────────────────────────────────────
function tokenise(text) {
    const tokens = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3);
    return new Set(tokens);
}
function countOverlap(a, b) {
    let n = 0;
    for (const tok of a)
        if (b.has(tok))
            n += 1;
    return n;
}
//# sourceMappingURL=PlatformLessonRecall.js.map