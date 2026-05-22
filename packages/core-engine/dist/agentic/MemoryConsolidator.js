"use strict";
/**
 * MemoryConsolidator — scheduled background job that clusters recent semantic
 * memories by shared tags and synthesises each cluster into a single
 * tenant-wide semantic entry.
 *
 * R-11 fix: each entry is bucketed under ALL of its tags, not just
 * the first one. This means a memory tagged ['typescript', 'auth'] contributes
 * to both the 'typescript' cluster and the 'auth' cluster, so cross-cutting
 * insights are not lost.
 *
 * Consolidation pipeline per cluster:
 *   1. summariseCluster() — LLM call (stubbed; wire ModelRouter in §9).
 *   2. Parse JSON response, stripping ```json fences.
 *   3. qdrant.upsert() — write new kind:'domain-fact' point with tenant scope.
 *   4. Fire-and-forget setPayload() on all source entries setting consolidated_at,
 *      preventing them from being reprocessed in future cycles.
 *
 * Retry: summariseCluster() failures retry once; if both attempts fail the
 * cluster is skipped without writing consolidated_at (safe to retry next cycle).
 *
 * Concurrency: up to config.maxConcurrentTenants tenants in parallel (p-limit v3).
 *
 * Phase 2b: Migrated from legacy MemoryEntry to contract types.
 * Phase 3:  Uses the contract `tags` field for clustering.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryConsolidator = exports.DEFAULT_CONSOLIDATOR_CONFIG = void 0;
const crypto_1 = require("crypto");
const p_limit_1 = __importDefault(require("p-limit"));
const TenantKeyBuilder_js_1 = require("../infra/TenantKeyBuilder.js");
const seedTags_js_1 = require("./memory/seedTags.js");
exports.DEFAULT_CONSOLIDATOR_CONFIG = {
    windowDays: 7,
    minClusterSize: 3,
    maxClustersPerCycle: 20,
    maxConcurrentTenants: 10,
};
// ─── Kinds excluded from consolidation ────────────────────────────────────────
/**
 * These kinds are owned by other tiers and should never appear in the semantic
 * store. If they do, skip them during consolidation.
 */
const EXCLUDED_KINDS = new Set([
    'user-preference',
    'project-invariant',
    'conversation-summary',
]);
// ─── Service ──────────────────────────────────────────────────────────────────
class MemoryConsolidator {
    qdrant;
    embedder;
    config;
    tenantIds;
    logger;
    constructor(qdrant, embedder, config, tenantIds, logger) {
        this.qdrant = qdrant;
        this.embedder = embedder;
        this.config = config;
        this.tenantIds = tenantIds;
        this.logger = logger;
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * runConsolidationCycle — iterate over all tenants and consolidate each one.
     * Uses p-limit to cap concurrency at config.maxConcurrentTenants.
     */
    async runConsolidationCycle() {
        const tenants = await this.tenantIds();
        this.logger.info('[MemoryConsolidator] starting consolidation cycle', { tenantCount: tenants.length });
        const limit = (0, p_limit_1.default)(this.config.maxConcurrentTenants);
        await Promise.all(tenants.map(tenantId => limit(() => this.consolidateTenant(tenantId))));
        this.logger.info('[MemoryConsolidator] consolidation cycle complete');
    }
    // ── Private implementation ─────────────────────────────────────────────────
    /**
     * consolidateTenant — scroll for unconsolidated entries within the
     * time window, cluster them by tag, and consolidate qualifying clusters.
     */
    async consolidateTenant(tenantId) {
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        const windowStart = new Date(Date.now() - this.config.windowDays * 86_400_000).toISOString();
        // Scroll for entries created within the window that have not yet been consolidated.
        const page = await this.qdrant.scroll(collection, {
            limit: 1_000, // generous cap — clusters are bounded downstream
            with_payload: true,
            with_vector: false,
            filter: {
                must: [
                    { key: 'consolidated_at', is_null: true },
                    { key: 'created_at', range: { gte: windowStart } },
                ],
                must_not: [
                    ...Array.from(EXCLUDED_KINDS).map(k => ({ key: 'kind', match: { value: k } })),
                ],
            },
        });
        const entries = (page.points ?? []).map(p => ({
            id: p.id,
            payload: p.payload,
        }));
        if (entries.length === 0)
            return;
        // Cluster by tags (R-11: each entry appears under ALL its tags).
        const clusters = this.clusterByTags(entries);
        // Filter to qualifying clusters, sort largest-first (highest value first),
        // take at most maxClustersPerCycle — ensures the LLM budget cap is respected.
        const qualifying = [...clusters.entries()]
            .filter(([, members]) => members.length >= this.config.minClusterSize)
            .sort(([, a], [, b]) => b.length - a.length)
            .slice(0, this.config.maxClustersPerCycle);
        this.logger.debug('[MemoryConsolidator] clusters found', {
            tenantId,
            total: clusters.size,
            qualifying: qualifying.length,
        });
        for (const [tag, clusterEntries] of qualifying) {
            await this.consolidateCluster(tenantId, tag, clusterEntries);
        }
    }
    /**
     * clusterByTags — bucket entries by each of their tags.
     *
     * R-11 fix: a memory tagged ['typescript', 'auth'] is pushed into BOTH the
     * 'typescript' bucket and the 'auth' bucket. Using only tags[0] would miss
     * cross-cutting signals.
     */
    clusterByTags(entries) {
        const map = new Map();
        for (const entry of entries) {
            const tags = Array.isArray(entry.payload.tags) ? entry.payload.tags : [];
            // T.2.a: platform-curated seed entries are never promoted by the
            // consolidator. Promoting a seed would create a near-duplicate entry,
            // polluting recall and inflating Qdrant storage. Operators harvest
            // popular seeds via the T.7 catalog-revision flow.
            if ((0, seedTags_js_1.isSeedTagged)(tags)) {
                continue;
            }
            for (const tag of tags) {
                // Don't bucket *into* a seed tag either — even an organic entry
                // sharing the tag should not be clustered alongside seeds.
                if (typeof tag === 'string' && tag.startsWith('seed:'))
                    continue;
                const bucket = map.get(tag) ?? [];
                bucket.push(entry);
                map.set(tag, bucket);
            }
        }
        return map;
    }
    /**
     * consolidateCluster — synthesise a tag cluster into a single semantic entry.
     *
     * summariseCluster() is attempted up to twice. Both failures → skip cluster
     * without writing consolidated_at (safe to retry on the next cycle).
     * JSON parse failures after both attempts → same skip-and-warn behaviour.
     */
    async consolidateCluster(tenantId, tag, entries) {
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        // ── Summarise (with one retry) ─────────────────────────────────────────
        let raw;
        try {
            raw = await this.summariseCluster(entries.map(e => e.payload));
        }
        catch {
            try {
                raw = await this.summariseCluster(entries.map(e => e.payload));
            }
            catch (secondErr) {
                this.logger.warn('[MemoryConsolidator] summariseCluster failed twice — skipping cluster', { tenantId, tag, clusterSize: entries.length, error: secondErr.message });
                return;
            }
        }
        // ── Parse JSON response ────────────────────────────────────────────────
        // Strip optional ```json ... ``` fences that LLMs often wrap around JSON.
        const stripped = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        let parsed;
        try {
            parsed = JSON.parse(stripped);
        }
        catch {
            this.logger.warn('[MemoryConsolidator] JSON parse failed for cluster summary — skipping cluster', { tenantId, tag, clusterSize: entries.length, raw: stripped.slice(0, 200) });
            return;
        }
        const summary = parsed.summary;
        if (!summary) {
            this.logger.warn('[MemoryConsolidator] parsed summary missing "summary" field — skipping cluster', { tenantId, tag, clusterSize: entries.length });
            return;
        }
        // ── Upsert the new semantic entry ──────────────────────────────────────
        const newId = (0, crypto_1.randomUUID)();
        const now = new Date().toISOString();
        const vector = await this.embedder(summary);
        const consolidated = {
            tenant_id: tenantId,
            kind: 'domain-fact',
            summary,
            detail: { sourceTag: tag, sourceCount: entries.length },
            tags: [tag],
            importance: 0.5,
            created_at: now,
            updated_at: now,
            recall_count: 0,
            _source: 'oweibo-memory-consolidator/v2',
        };
        await this.qdrant.upsert(collection, {
            wait: true,
            points: [{ id: newId, vector, payload: consolidated }],
        });
        // ── Mark source entries as consolidated (fire-and-forget) ──────────────
        // Prevents reprocessing in future cycles. Failure here is acceptable — the
        // worst case is that the same entries get summarised again next cycle, which
        // produces a harmless duplicate semantic entry rather than data loss.
        void Promise.all(entries.map(e => this.qdrant.setPayload(collection, {
            payload: { consolidated_at: now },
            points: [e.id],
        }))).catch((err) => {
            this.logger.warn('[MemoryConsolidator] setPayload (consolidated_at) partially failed', { tenantId, tag, error: err.message });
        });
        this.logger.debug('[MemoryConsolidator] cluster consolidated', {
            tenantId,
            tag,
            sourceCount: entries.length,
            newId,
        });
    }
    /**
     * summariseCluster — produce a JSON summary for a cluster of entries.
     *
     * // TODO: wire ModelRouter (§9) — replace stub body with a structured LLM call
     * // that returns JSON { summary: string } describing what the cluster represents.
     */
    async summariseCluster(_entries) {
        // TODO: wire ModelRouter (§9)
        return JSON.stringify({ summary: 'stub – wire LLM (§9)' });
    }
}
exports.MemoryConsolidator = MemoryConsolidator;
//# sourceMappingURL=MemoryConsolidator.js.map