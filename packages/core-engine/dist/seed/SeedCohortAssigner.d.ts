export type SeedCohort = 'seeded' | 'control' | 'exempt';
export interface SeedCohortAssignerOptions {
    /** When false, every tenant is assigned 'seeded' regardless of id.
     *  Default: env SEED_AB_ENABLED === 'true'. */
    isEnabled?: () => boolean;
    /** When the assigner sees a tenantId in this set, it returns 'exempt'.
     *  Used to keep internal / synthetic tenants out of cohort statistics. */
    exemptTenantIds?: ReadonlySet<string>;
}
export declare class SeedCohortAssigner {
    private readonly isEnabled;
    private readonly exempt;
    constructor(opts?: SeedCohortAssignerOptions);
    /**
     * Deterministically assign a cohort to a tenant id. Same input always
     * yields the same output across processes — the assigner is safe to call
     * from any service (tenant-create handler, backfill script, analysis).
     */
    assign(tenantId: string): SeedCohort;
}
//# sourceMappingURL=SeedCohortAssigner.d.ts.map