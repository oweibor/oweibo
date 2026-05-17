import type { Pool } from 'pg';
export interface TenantCohortRow {
    tenantId: string;
    name: string | null;
    cohortChannel: string;
    lastChangedAt: string | null;
    lastChangedBy: string | null;
    lastChangeReason: string | null;
}
export interface CohortChangeRecord {
    id: string;
    tenantId: string;
    previousChannel: string;
    newChannel: string;
    reason: string;
    changedBy: string;
    changedAt: string;
}
export interface SetTenantCohortInput {
    tenantId: string;
    newChannel: string;
    reason: string;
    changedBy: string;
}
export type SetTenantCohortResult = {
    ok: true;
    previousChannel: string;
} | {
    ok: false;
    error: 'tenant_not_found' | 'unknown_channel' | 'no_change';
    message: string;
};
export declare class CohortAdminService {
    private readonly pool;
    constructor(pool: Pool);
    /**
     * Every tenant joined to its tenant_settings.cohort_channel.
     * Tenants without a settings row are surfaced with the default 'stable-v0'.
     */
    listTenants(): Promise<TenantCohortRow[]>;
    /**
     * Distinct channel names actually present in oweibo.channels.
     * Plus the always-available 'stable-v0' baseline returned by CohortRouter
     * as the universal fallback.
     */
    listChannels(): Promise<string[]>;
    /** Atomic cohort change + audit. */
    setTenantCohort(input: SetTenantCohortInput): Promise<SetTenantCohortResult>;
    /** Most-recent cohort changes, newest first. */
    listRecentChanges(limit?: number): Promise<CohortChangeRecord[]>;
    /**
     * Read-only resolution used by SwarmCoordinator at task start.
     * Always falls back to 'stable-v0' on missing tenant_settings or any error
     * — never throws into the task path (mirrors CohortRouter invariant §2.8).
     */
    resolveCohortFor(tenantId: string): Promise<string>;
}
//# sourceMappingURL=CohortAdminService.d.ts.map