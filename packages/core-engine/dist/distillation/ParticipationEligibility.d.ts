export interface TenantEligibilityRecord {
    readonly tenantId: string;
    readonly accountAgeMs: number;
    readonly paymentStatus: 'current' | 'lapsed' | 'trial' | 'cancelled';
    readonly humanTaskInteractions: number;
    readonly hasActiveAnomalyFlag: boolean;
}
export type EligibilityReason = 'ok' | 'account_too_new' | 'payment_not_current' | 'insufficient_interactions' | 'active_anomaly_flag';
export interface EligibilityResult {
    readonly eligible: boolean;
    readonly reason: EligibilityReason;
}
/**
 * Evaluate eligibility against the four criteria (§B.6b).
 * Pure function — caller provides the record from DB/cache.
 */
export declare function evaluateEligibility(record: TenantEligibilityRecord): EligibilityResult;
/** Redis TTL for eligibility cache entries (5 minutes = 300 seconds). */
export declare const ELIGIBILITY_CACHE_TTL_S = 300;
/** Redis key for a tenant's eligibility cache entry. */
export declare function eligibilityCacheKey(tenantId: string): string;
export interface EligibilityStore {
    readonly getRecord: (tenantId: string) => Promise<TenantEligibilityRecord | null>;
    readonly rGet: (key: string) => Promise<string | null>;
    readonly rSetEx: (key: string, ttlSeconds: number, value: string) => Promise<void>;
}
/**
 * Check eligibility with Redis caching.
 * Returns the eligibility decision and populates the cache if a DB lookup was needed.
 */
export declare function checkEligibility(tenantId: string, store: EligibilityStore): Promise<EligibilityResult>;
//# sourceMappingURL=ParticipationEligibility.d.ts.map