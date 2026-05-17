import type { Pool } from 'pg';
export interface DlpRejectsTimelinePoint {
    day: string;
    stage: string;
    count: number;
}
export interface DlpRejectsByStage {
    stage: string;
    count: number;
}
export interface BlockedBucket {
    bucketKey: string;
    role: string;
    slotId: string;
    lessonCount: number;
    tenantCount: number;
    oldestLessonAt: string;
    latestLessonAt: string;
}
export interface EquityViolation {
    bucketKey: string;
    role: string;
    slotId: string;
    totalLessons: number;
    totalTenants: number;
    dominantTenantPct: number;
}
export interface PrivacyOverview {
    totalLessons: number;
    totalBuckets: number;
    releasableBuckets: number;
    blockedBuckets: number;
    totalRejectsLast7d: number;
    participatingTenants: number;
}
export declare class PrivacyAuditService {
    private readonly pool;
    constructor(pool: Pool);
    overview(): Promise<PrivacyOverview>;
    /** Daily DLP reject counts per stage, oldest first (good for chart x-axis). */
    dlpRejectsTimeline(days?: number): Promise<DlpRejectsTimelinePoint[]>;
    /** Reject totals grouped by stage over the window. */
    dlpRejectsByStage(days?: number): Promise<DlpRejectsByStage[]>;
    /**
     * Buckets that have lessons but haven't crossed the k=5 tenants threshold.
     * These are blocked from `releasable_buckets` and invisible to GEPA.
     */
    blockedBuckets(limit?: number): Promise<BlockedBucket[]>;
    /**
     * Per-bucket, the max % of lessons contributed by any single tenant.
     * Returns only buckets that violate the 10% invariant — i.e. one tenant
     * dominates > 10% of the bucket — so the page can show the offenders.
     *
     * Note: platform_lessons has no tenant_hash column (intentional — only
     * fingerprint of the lesson, not the tenant). platform_lesson_tenants
     * records which tenants contributed to each bucket but not how many
     * each contributed. Without per-(tenant, bucket) lesson counts, this
     * method approximates "dominance" as: if a bucket has lessonCount
     * lessons but only N distinct tenants, the average per-tenant share is
     * lessonCount / N. We compare that average to 10% as a *minimum
     * dominance* — actual dominance can only be higher. A future enhancement
     * would add per-(tenant,bucket) lesson counts to platform_lesson_tenants.
     */
    equityViolations(): Promise<EquityViolation[]>;
}
//# sourceMappingURL=PrivacyAuditService.d.ts.map