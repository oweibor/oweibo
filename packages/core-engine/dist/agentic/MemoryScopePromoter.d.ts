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
import type { Logger } from './MemoryDecayService.js';
type QdrantClient = any;
export interface PromoterConfig {
    promotionThreshold: number;
    maxPromotionsPerCycle: number;
    maxConcurrentTenants: number;
}
export declare const DEFAULT_PROMOTER_CONFIG: PromoterConfig;
export declare class MemoryScopePromoter {
    private readonly qdrant;
    private readonly config;
    private readonly tenantIds;
    private readonly logger;
    constructor(qdrant: QdrantClient, config: PromoterConfig, tenantIds: () => Promise<string[]>, logger: Logger);
    /**
     * runPromotionCycle — iterate over all tenants and promote eligible entries.
     *
     * Uses p-limit to cap concurrency at config.maxConcurrentTenants.
     */
    runPromotionCycle(): Promise<void>;
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
    private promoteTenant;
}
export {};
//# sourceMappingURL=MemoryScopePromoter.d.ts.map