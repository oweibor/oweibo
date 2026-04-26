"use strict";
/**
 * MemoryScopePromoter — scheduled background job that promotes high-confidence
 * procedural memories to tenant-wide scope.
 *
 * A procedural memory is a candidate for promotion when:
 *   - tier === 'procedural'
 *   - successCount >= config.promotionThreshold
 *   - promotedToId is null (not yet promoted — idempotency lock)
 *
 * Promotion writes a new Qdrant point at scope 'tenant:{tenantId}' (a copy of
 * the source entry with a fresh UUID), then marks the original with promotedToId
 * pointing at the new entry. Step 4 always follows step 3: if the upsert fails,
 * the original remains unmarked and the next cycle will retry it safely.
 *
 * Concurrency: up to config.maxConcurrentTenants tenants run in parallel (p-limit v3).
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
     * Filter: tier=procedural AND successCount >= promotionThreshold AND
     *         promotedToId IS NULL (not yet promoted).
     * Cap: stops after maxPromotionsPerCycle entries to bound each cycle's I/O.
     *
     * Per candidate:
     *   3. qdrant.upsert() — write new point at tenant-wide scope.
     *   4. qdrant.setPayload() — mark original with promotedToId (idempotency lock).
     *      Step 4 only runs if step 3 succeeds; a failed upsert leaves the original
     *      unmarked so the next cycle will retry it safely.
     */
    async promoteTenant(tenantId) {
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        const tenantScope = `tenant:${tenantId}`;
        let promoted = 0;
        // Scroll for candidates: procedural tier, sufficient success count, not yet promoted.
        // Qdrant filter uses must[] with match conditions.
        const page = await this.qdrant.scroll(collection, {
            limit: this.config.maxPromotionsPerCycle,
            with_payload: true,
            with_vector: true, // vector must be copied to the new point
            filter: {
                must: [
                    { key: 'tier', match: { value: 'procedural' } },
                    { key: 'successCount', range: { gte: this.config.promotionThreshold } },
                    { key: 'promotedToId', is_null: true },
                ],
            },
        });
        const candidates = page.points ?? [];
        for (const point of candidates) {
            if (promoted >= this.config.maxPromotionsPerCycle)
                break;
            const source = point.payload;
            const newId = (0, crypto_1.randomUUID)();
            const now = Date.now();
            // ── Step 3: write the promoted copy at tenant-wide scope ───────────────
            // All fields are copied from the source entry; only id and scope differ.
            // promotedToId is intentionally left unset on the new entry — it is the
            // promoted destination, not a pointer to another entry.
            const promotedEntry = {
                ...source,
                id: newId,
                scope: tenantScope,
                createdAt: now,
                lastAccessedAt: now,
                // Inherit all counters and confidence — the promoted copy starts with
                // the same signal strength as the original.
                promotedToId: undefined,
            };
            try {
                await this.qdrant.upsert(collection, {
                    points: [{
                            id: newId,
                            vector: point.vector,
                            payload: promotedEntry,
                        }],
                });
            }
            catch (err) {
                // Upsert failed — do NOT mark the original as promoted.
                // The next cycle will find it unmarked and retry.
                this.logger.warn('[MemoryScopePromoter] upsert failed — skipping idempotency lock', { tenantId, sourceId: point.id, error: err.message });
                continue;
            }
            // ── Step 4: lock the original against double-promotion ─────────────────
            // Only reached if step 3 succeeded. A failure here is logged but does not
            // roll back the new entry — next cycle will find promotedToId still null
            // and create a second copy, which is harmless and will itself be locked.
            try {
                await this.qdrant.setPayload(collection, {
                    payload: { promotedToId: newId },
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
                scope: tenantScope,
            });
        }
        if (promoted > 0) {
            this.logger.info('[MemoryScopePromoter] tenant promotion complete', { tenantId, promoted });
        }
    }
}
exports.MemoryScopePromoter = MemoryScopePromoter;
//# sourceMappingURL=MemoryScopePromoter.js.map