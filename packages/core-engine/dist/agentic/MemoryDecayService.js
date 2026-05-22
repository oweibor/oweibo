"use strict";
/**
 * MemoryDecayService — scheduled background job for LTM importance decay and eviction.
 *
 * runDecayCycle() is the only public entry point. It scrolls every tenant's Qdrant
 * collection in bounded batches, applies exponential importance decay, archives
 * entries below the eviction threshold to Postgres, and deletes them from Qdrant.
 *
 * Decay model:
 *   λ = ln(2) / kindHalfLife[entry.kind]   (kind-specific decay constant)
 *   newImportance = entry.importance * exp(-λ * daysSinceLastUpdated)
 *
 * Entries whose newImportance drops below decayEvictionThreshold are evicted:
 *   1. Archived to ltm_archive via parameterised bulk INSERT (never string-interpolated).
 *   2. Deleted from Qdrant.
 *
 * Entries above the threshold have their importance updated in-place via setPayload().
 *
 * Concurrency: up to config.maxConcurrentTenants tenants run in parallel (p-limit v3).
 * Archive failures are logged at warn level and must not abort the decay cycle.
 *
 * Phase 2b: Migrated from legacy MemoryEntry/MemoryTier to contract types.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryDecayService = exports.DEFAULT_DECAY_CONFIG = void 0;
const p_limit_1 = __importDefault(require("p-limit"));
const TenantKeyBuilder_js_1 = require("../infra/TenantKeyBuilder.js");
/**
 * Default half-lives per MemoryKind (days).
 *
 * Fast-decay: episodic signals (tool-heuristic, open-question)
 * Medium-decay: structured knowledge (failure-lesson, domain-fact, code-landmark)
 * Slow-decay: durable decisions (success-pattern, architectural-decision, decision-rationale)
 */
const DEFAULT_KIND_HALF_LIFE = {
    'tool-heuristic': 7,
    'open-question': 7,
    'failure-lesson': 30,
    'domain-fact': 90,
    'code-landmark': 90,
    'success-pattern': 180,
    'architectural-decision': 180,
    'decision-rationale': 180,
};
/** Fallback for any kind not in the explicit map. */
const DEFAULT_HALF_LIFE_DAYS = 30;
exports.DEFAULT_DECAY_CONFIG = {
    kindHalfLife: DEFAULT_KIND_HALF_LIFE,
    decayEvictionThreshold: 0.05,
    maxPointsPerCyclePerTenant: 1_000,
    interBatchDelayMs: 200,
    maxConcurrentTenants: 10,
};
// T.2.a: predicate imported from a shared module so MemoryDecayService,
// MemoryConsolidator, and MemoryWarmer agree on the same definition of
// "platform-curated seed entry".
const seedTags_js_1 = require("./memory/seedTags.js");
// ─── Service ──────────────────────────────────────────────────────────────────
class MemoryDecayService {
    qdrant;
    pg;
    config;
    tenantIds;
    logger;
    constructor(qdrant, pg, config, 
    /** Async factory that returns the current list of tenant IDs to process. */
    tenantIds, logger) {
        this.qdrant = qdrant;
        this.pg = pg;
        this.config = config;
        this.tenantIds = tenantIds;
        this.logger = logger;
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * runDecayCycle — iterate over all tenants and decay each one's LTM collection.
     *
     * Uses p-limit to cap concurrency at config.maxConcurrentTenants so a large
     * tenant roster does not flood Qdrant with parallel scroll requests.
     */
    async runDecayCycle() {
        const tenants = await this.tenantIds();
        this.logger.info('[MemoryDecayService] starting decay cycle', { tenantCount: tenants.length });
        const limit = (0, p_limit_1.default)(this.config.maxConcurrentTenants);
        await Promise.all(tenants.map(tenantId => limit(() => this.decayTenant(tenantId))));
        this.logger.info('[MemoryDecayService] decay cycle complete');
    }
    // ── Private implementation ─────────────────────────────────────────────────
    /**
     * decayTenant — scroll a tenant's collection in 100-point batches and apply
     * the exponential importance decay formula to each entry.
     *
     * Evicted entries are archived first (best-effort) then deleted from Qdrant.
     * Updates are written with setPayload() so the vector is never re-embedded.
     */
    async decayTenant(tenantId) {
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        const BATCH_SIZE = 100;
        const now = Date.now();
        let totalProcessed = 0;
        let nextPageOffset = null;
        do {
            // ── Scroll one page ────────────────────────────────────────────────────
            const page = await this.qdrant.scroll(collection, {
                limit: BATCH_SIZE,
                with_payload: true,
                with_vector: false,
                ...(nextPageOffset !== null ? { offset: nextPageOffset } : {}),
            });
            const { points, next_page_offset } = page;
            nextPageOffset = next_page_offset ?? null;
            // ── Classify each point ────────────────────────────────────────────────
            const toUpdate = [];
            const toEvict = [];
            for (const point of points) {
                const payload = point.payload;
                // T.2.a: skip platform-curated seed entries. They are exempt from
                // both decay and eviction; only the explicit retirement flow (T.7)
                // can remove them. Filed under tags, not kind, so this is a fast
                // string-prefix check.
                if ((0, seedTags_js_1.isSeedTagged)(payload.tags)) {
                    continue;
                }
                // Kind-specific decay constant: λ = ln(2) / halfLifeDays
                const kind = (payload.kind ?? 'domain-fact');
                const halfLife = this.config.kindHalfLife[kind] ?? DEFAULT_HALF_LIFE_DAYS;
                const λ = Math.LN2 / halfLife;
                const updatedAtStr = payload.updated_at ?? payload.created_at;
                const updatedAtMs = updatedAtStr ? new Date(updatedAtStr).getTime() : now;
                const daysSince = Math.max(0, (now - updatedAtMs) / 86_400_000);
                const currentImportance = payload.importance ?? 0.5;
                const newImportance = currentImportance * Math.exp(-λ * daysSince);
                if (newImportance < this.config.decayEvictionThreshold) {
                    toEvict.push({ id: point.id, payload });
                }
                else {
                    toUpdate.push({ id: point.id, newImportance });
                }
            }
            // ── Apply updates ──────────────────────────────────────────────────────
            // Update surviving entries in-place — no re-embedding needed.
            for (const { id, newImportance } of toUpdate) {
                await this.qdrant.setPayload(collection, {
                    payload: { importance: newImportance },
                    points: [id],
                });
            }
            // ── Evict entries below threshold ──────────────────────────────────────
            if (toEvict.length > 0) {
                // 1. Archive first (best-effort — failure must not abort the eviction).
                await this.archiveEntries(toEvict, tenantId);
                // 2. Delete from Qdrant.
                await this.qdrant.delete(collection, {
                    points: toEvict.map(e => e.id),
                });
            }
            this.logger.debug('[MemoryDecayService] batch processed', {
                tenantId,
                batchSize: points.length,
                updated: toUpdate.length,
                evicted: toEvict.length,
            });
            totalProcessed += points.length;
            // Back-pressure between batches to avoid flooding Qdrant.
            if (nextPageOffset !== null && totalProcessed < this.config.maxPointsPerCyclePerTenant) {
                await new Promise(r => setTimeout(r, this.config.interBatchDelayMs));
            }
        } while (nextPageOffset !== null &&
            totalProcessed < this.config.maxPointsPerCyclePerTenant);
        this.logger.info('[MemoryDecayService] tenant decay complete', { tenantId, totalProcessed });
    }
    /**
     * archiveEntries — bulk INSERT evicted entries into ltm_archive.
     *
     * Uses $1…$(6n) parameterised placeholders — entry fields are NEVER
     * string-interpolated into SQL. Errors are swallowed at warn level so
     * archive failure never aborts the decay cycle (entries still get deleted
     * from Qdrant — a missing archive row is preferable to a stuck decay job).
     *
     * Columns archived: id, tenant_id, kind, summary, importance, evicted_at
     */
    async archiveEntries(entries, tenantId) {
        if (entries.length === 0)
            return;
        try {
            const COLS = 6; // id, tenant_id, kind, summary, importance, evicted_at
            const evictedAt = new Date();
            // Build: ($1,$2,$3,$4,$5,$6), ($7,$8,$9,$10,$11,$12), …
            const placeholders = entries
                .map((_, rowIdx) => {
                const base = rowIdx * COLS;
                const cols = Array.from({ length: COLS }, (_, i) => `$${base + i + 1}`);
                return `(${cols.join(',')})`;
            })
                .join(',');
            const values = [];
            for (const e of entries) {
                values.push(e.id, tenantId, e.payload.kind ?? 'domain-fact', e.payload.summary ?? '', e.payload.importance ?? 0, evictedAt);
            }
            await this.pg.query(`INSERT INTO ltm_archive
           (id, tenant_id, kind, summary, importance, evicted_at)
         VALUES ${placeholders}
         ON CONFLICT (id) DO NOTHING`, values);
        }
        catch (err) {
            // Archive failure is non-fatal — log and continue so Qdrant eviction still runs.
            this.logger.warn('[MemoryDecayService] archiveEntries failed — entries will be evicted without archive record', { tenantId, count: entries.length, error: err.message });
        }
    }
}
exports.MemoryDecayService = MemoryDecayService;
//# sourceMappingURL=MemoryDecayService.js.map