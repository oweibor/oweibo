/**
 * S.6 (ttv-action-safety-v2): action quota + budget contracts.
 *
 * Quotas are absolute caps over long windows (day / month / year),
 * distinct from S.2 rate limits which control short-window flow.
 * Quotas address: "you've consumed your daily $50 API budget — stop
 * until tomorrow."
 *
 * The contract is intentionally narrow: the trust ladder calls
 * `IQuotaService.preflight()` once per gate(). If the result is `denied`
 * the gate returns `forbidden` with a `quota_exhausted` reason.
 * `record()` is called by the executor after an action runs to update
 * the running counters.
 */
import type { ActionClass } from './ActionClass.js';
export type QuotaKind = 'action_count_per_class' | 'usd_cost_per_class' | 'usd_cost_total' | 'total_actions' | 'blast_radius_user_count';
export type QuotaWindow = 'day' | 'month' | 'year';
export type QuotaEnforcementMode = 'soft' | 'hard';
export interface QuotaPolicy {
    readonly tenantId: string;
    readonly quotaKind: QuotaKind;
    /** Action class for *_per_class kinds; '*' for tenant-wide totals. */
    readonly scope: ActionClass | '*';
    readonly window: QuotaWindow;
    /** Steady-state cap. */
    readonly limitValue: number;
    /** Optional override active during the first N days of tenant life. */
    readonly coldStartLimit?: number;
    readonly coldStartDurationDays: number;
    /** soft = log-but-allow; hard = block. */
    readonly enforcementMode: QuotaEnforcementMode;
}
export interface QuotaConsumption {
    readonly tenantId: string;
    readonly quotaKind: QuotaKind;
    readonly scope: ActionClass | '*';
    readonly window: QuotaWindow;
    /** ISO date (yyyy-mm-dd) for the window's start. */
    readonly windowStart: string;
    readonly consumed: number;
    readonly limit: number;
    /** True iff this row is the currently-active window. */
    readonly active: boolean;
}
export type QuotaPreflightResult = {
    kind: 'allow';
} | {
    kind: 'soft_warn';
    /** Quota that triggered the warning; consumption already exceeds limit. */
    readonly quotaKind: QuotaKind;
    readonly scope: ActionClass | '*';
    readonly window: QuotaWindow;
    readonly limit: number;
    readonly consumed: number;
    readonly resetAt: string;
} | {
    kind: 'deny';
    readonly quotaKind: QuotaKind;
    readonly scope: ActionClass | '*';
    readonly window: QuotaWindow;
    readonly limit: number;
    readonly consumed: number;
    /** ISO timestamp at which the window resets. */
    readonly resetAt: string;
};
/**
 * The trust ladder consults this BEFORE writing a proposal row. The
 * implementation reads quota_policies + quota_consumption, applies
 * cold-start ramp, and decides allow/soft_warn/deny.
 */
export interface IQuotaService {
    /**
     * Returns the worst-of (most-restrictive) result across all matching
     * quotas. `estimatedCostUsdCents` is the cost the action is expected
     * to consume — used for usd_cost_* quotas. If omitted, cost quotas
     * are evaluated against 0 (always within limit).
     */
    preflight(args: {
        readonly tenantId: string;
        readonly actionClass: ActionClass;
        readonly estimatedCostUsdCents?: number;
        readonly blastRadiusUsers?: number;
    }): Promise<QuotaPreflightResult>;
    /**
     * Records consumption after an action executes. Called by the
     * executor (or the gate itself for actions that bypass an external
     * executor). MUST be idempotent at the (tenantId, actionId) level if
     * called multiple times — implementations dedupe via an actionId
     * argument when available.
     */
    record(args: {
        readonly tenantId: string;
        readonly actionClass: ActionClass;
        readonly actualCostUsdCents?: number;
        readonly blastRadiusUsers?: number;
    }): Promise<void>;
}
export type PayloadSizeBucket = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export interface BudgetEstimate {
    readonly costUsdCents: number;
    readonly source: 'tenant_history' | 'platform_prior' | 'platform_default';
    /** Tightness signal — confidence that the estimate matches reality. */
    readonly confidence: 'high' | 'medium' | 'low';
    /** Optional capability slug used in the lookup. */
    readonly capabilityId?: string;
    readonly payloadSizeBucket?: PayloadSizeBucket;
}
export interface IBudgetEstimator {
    estimate(args: {
        readonly tenantId: string;
        readonly actionClass: ActionClass;
        readonly capabilityId?: string;
        readonly payload?: unknown;
        /** EU / US-east / ... — when supplied, drives region-segmented priors. */
        readonly homeRegion?: string;
    }): Promise<BudgetEstimate>;
}
/**
 * Bucket a serialized payload into one of five size bins. Stable across
 * runs; used as a join key for cost prior lookups.
 *
 *   xs:  0..512 B
 *   sm:  512 B..4 KB
 *   md:  4 KB..32 KB
 *   lg:  32 KB..256 KB
 *   xl:  > 256 KB
 */
export declare function bucketPayloadSize(payloadBytes: number): PayloadSizeBucket;
//# sourceMappingURL=Quota.d.ts.map