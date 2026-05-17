"use strict";
/**
 * MemoryScopePromoter — scheduled background job that promotes high-recall
 * memories to tenant-wide scope.
 *
 * A memory is a candidate for promotion when:
 *   - recall_count >= config.promotionThreshold
 *   - promoted_at is null (not yet promoted — idempotency lock)
 *
 * Promotion writes a new Qdrant point at scope 'tenant:{tenantId}' (a copy of
 * the source entry with a fresh UUID), then marks the original with promoted_at
 * pointing at the new entry. Step 3 always follows step 2: if the upsert fails,
 * the original remains unmarked and the next cycle will retry it safely.
 *
 * Concurrency: up to config.maxConcurrentTenants tenants run in parallel (p-limit v3).
 *
 * Phase 2b: Migrated from legacy MemoryEntry/MemoryTier to contract types.
 *           Promotion now uses recall_count instead of successCount/tier.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryScopePromoter = exports.DEFAULT_PROMOTER_CONFIG = void 0;
const crypto_1 = require("crypto");
const p_limit_1 = __importDefault(require("p-limit"));
const TenantKeyBuilder_js_1 = require("../infra/TenantKeyBuilder.js");
exports.DEFAULT_PROMOTER_CONFIG = {
    promotionThreshold: 3,
    maxPromotionsPerCycle: 50,
    maxConcurrentTenants: 10,
};
// ─── Service ──────────────────────────────────────────────────────────────────
class MemoryScopePromoter {
    qdrant;
    config;
    tenantIds;
    logger;
    constructor(qdrant, config, tenantIds, logger) {
        this.qdrant = qdrant;
        this.config = config;
        this.tenantIds = tenantIds;
        this.logger = logger;
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    /**
     * runPromotionCycle — iterate over all tenants and promote eligible entries.
     *
     * Uses p-limit to cap concurrency at config.maxConcurrentTenants.
     */
    async runPromotionCycle() {
        const tenants = await this.tenantIds();
        this.logger.info('[MemoryScopePromoter] starting promotion cycle', { tenantCount: tenants.length });
        const limit = (0, p_limit_1.default)(this.config.maxConcurrentTenants);
        await Promise.all(tenants.map(tenantId => limit(() => this.promoteTenant(tenantId))));
        this.logger.info('[MemoryScopePromoter] promotion cycle complete');
    }
    // ── Private implementation ─────────────────────────────────────────────────
    /**
     * promoteTenant — scroll for promotion candidates and promote each one.
     *
     * Filter: recall_count >= promotionThreshold AND promoted_at IS NULL.
     * Cap: stops after maxPromotionsPerCycle entries to bound each cycle's I/O.
     *
     * Per candidate:
     *   2. qdrant.upsert() — write new point at tenant-wide scope.
     *   3. qdrant.setPayload() — mark original with promoted_at (idempotency lock).
     *      Step 3 only runs if step 2 succeeds; a failed upsert leaves the original
     *      unmarked so the next cycle will retry it safely.
     */
    async promoteTenant(tenantId) {
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        let promoted = 0;
        // Scroll for candidates: sufficient recall count, not yet promoted.
        const page = await this.qdrant.scroll(collection, {
            limit: this.config.maxPromotionsPerCycle,
            with_payload: true,
            with_vector: true, // vector must be copied to the new point
            filter: {
                must: [
                    { key: 'recall_count', range: { gte: this.config.promotionThreshold } },
                    { key: 'promoted_at', is_null: true },
                ],
            },
        });
        const candidates = page.points ?? [];
        for (const point of candidates) {
            if (promoted >= this.config.maxPromotionsPerCycle)
                break;
            const source = point.payload;
            const newId = (0, crypto_1.randomUUID)();
            const now = new Date().toISOString();
            // ── Step 2: write the promoted copy at tenant-wide scope ───────────────
            const promotedPayload = {
                ...source,
                tenant_id: tenantId,
                project_id: undefined, // promoted to tenant-wide: clear project scope
                session_id: undefined,
                task_id: undefined,
                created_at: now,
                updated_at: now,
                recall_count: source.recall_count ?? 0,
                promoted_at: undefined, // the promoted copy is not itself promoted
                _source: 'oweibo-scope-promoter/v2',
            };
            try {
                await this.qdrant.upsert(collection, {
                    points: [{
                            id: newId,
                            vector: point.vector,
                            payload: promotedPayload,
                        }],
                });
            }
            catch (err) {
                // Upsert failed — do NOT mark the original as promoted.
                // The next cycle will find it unmarked and retry.
                this.logger.warn('[MemoryScopePromoter] upsert failed — skipping idempotency lock', { tenantId, sourceId: point.id, error: err.message });
                continue;
            }
            // ── Step 3: lock the original against double-promotion ─────────────────
            // Only reached if step 2 succeeded. A failure here is logged but does not
            // roll back the new entry — next cycle will find promoted_at still null
            // and create a second copy, which is harmless and will itself be locked.
            try {
                await this.qdrant.setPayload(collection, {
                    payload: { promoted_at: now },
                    points: [point.id],
                });
            }
            catch (err) {
                this.logger.warn('[MemoryScopePromoter] setPayload (idempotency lock) failed', { tenantId, sourceId: point.id, newId, error: err.message });
            }
            promoted++;
            this.logger.debug('[MemoryScopePromoter] promoted entry', {
                tenantId,
                sourceId: point.id,
                newId,
            });
        }
        if (promoted > 0) {
            this.logger.info('[MemoryScopePromoter] tenant promotion complete', { tenantId, promoted });
        }
    }
}
exports.MemoryScopePromoter = MemoryScopePromoter;
//# sourceMappingURL=MemoryScopePromoter.js.map