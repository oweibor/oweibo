"use strict";
// DONE: Phase B.6b — Participation eligibility filter.
// Four-criterion gate enforced before any lesson is distilled or the
// participate_in_pattern_bank toggle is flipped on.
// Redis-cached with 5-minute TTL.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ELIGIBILITY_CACHE_TTL_S = void 0;
exports.evaluateEligibility = evaluateEligibility;
exports.eligibilityCacheKey = eligibilityCacheKey;
exports.checkEligibility = checkEligibility;
const MIN_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days
const MIN_HUMAN_TASK_INTERACTIONS = 10;
/**
 * Evaluate eligibility against the four criteria (§B.6b).
 * Pure function — caller provides the record from DB/cache.
 */
function evaluateEligibility(record) {
    if (record.accountAgeMs < MIN_ACCOUNT_AGE_MS) {
        return { eligible: false, reason: 'account_too_new' };
    }
    if (record.paymentStatus !== 'current') {
        return { eligible: false, reason: 'payment_not_current' };
    }
    if (record.humanTaskInteractions < MIN_HUMAN_TASK_INTERACTIONS) {
        return { eligible: false, reason: 'insufficient_interactions' };
    }
    if (record.hasActiveAnomalyFlag) {
        return { eligible: false, reason: 'active_anomaly_flag' };
    }
    return { eligible: true, reason: 'ok' };
}
/** Redis TTL for eligibility cache entries (5 minutes = 300 seconds). */
exports.ELIGIBILITY_CACHE_TTL_S = 300;
/** Redis key for a tenant's eligibility cache entry. */
function eligibilityCacheKey(tenantId) {
    return `oweibo:eligibility:${tenantId}`;
}
/**
 * Check eligibility with Redis caching.
 * Returns the eligibility decision and populates the cache if a DB lookup was needed.
 */
async function checkEligibility(tenantId, store) {
    const cacheKey = eligibilityCacheKey(tenantId);
    // Try cache first
    const cached = await store.rGet(cacheKey);
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch { /* stale/corrupt cache — fall through */ }
    }
    // DB lookup
    const record = await store.getRecord(tenantId);
    if (!record) {
        // Unknown tenant → treat as ineligible
        return { eligible: false, reason: 'account_too_new' };
    }
    const result = evaluateEligibility(record);
    // Cache the result
    await store.rSetEx(cacheKey, exports.ELIGIBILITY_CACHE_TTL_S, JSON.stringify(result));
    return result;
}
//# sourceMappingURL=ParticipationEligibility.js.map