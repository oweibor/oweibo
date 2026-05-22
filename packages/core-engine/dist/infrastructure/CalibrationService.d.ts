import type { Pool } from 'pg';
import type { TenantReadinessSnapshot } from '@oweibo/core-contracts';
export interface CalibrationSignals {
    readonly accountAgeDays: number;
    readonly organicMemoryCount: number;
    readonly slotsWithLearnedArms: number;
    readonly completedTaskCount: number;
    readonly bootstrapReady: boolean;
    readonly actionClassObservations: Readonly<Record<string, number>>;
    readonly actionClassSuccessRatios: Readonly<Record<string, number>>;
}
export interface TenantReadiness {
    readonly tenantId: string;
    /** 0..1 — composite global readiness. 0 = brand new, 1 = fully calibrated. */
    readonly score: number;
    /** Per-action-class readiness, consumed by ActionTrustLadder. */
    readonly actionClassScores: Readonly<Record<string, number>>;
    readonly signals: CalibrationSignals;
    readonly summary: string;
    /** ISO timestamp at which this readiness was computed. */
    readonly snapshotAt: string;
    /** HMAC of the snapshot for integrity verification by downstream consumers. */
    readonly sourceSig: string;
}
/** Counter for organic (non-seed) memories. Injectable so the service does
 *  not have to know about Qdrant. Default returns 0 — safe under cold-start. */
export type OrganicMemoryCounter = (tenantId: string) => Promise<number>;
export interface CalibrationServiceOptions {
    countOrganicMemories?: OrganicMemoryCounter;
    /** Override the HMAC key. Tests pin this; production reads env. */
    sourceKey?: string;
    /** Override clock; tests pin time. */
    now?: () => Date;
}
export declare class CalibrationService {
    private readonly pool;
    private readonly countOrganic;
    private readonly sourceKey;
    private readonly now;
    constructor(pool: Pool, opts?: CalibrationServiceOptions);
    /** Compute a full readiness report for one tenant. */
    compute(tenantId: string): Promise<TenantReadiness>;
    /**
     * Build the minimal snapshot consumed by ActionTrustLadder.gate. The
     * snapshot is signed independently of the full TenantReadiness — its
     * signature excludes the global score (which the snapshot does not
     * carry), so verify() only needs the snapshot's own fields.
     */
    snapshot(tenantId: string): Promise<TenantReadinessSnapshot>;
    /** Verify that a snapshot was issued by this service. */
    verify(snapshot: TenantReadinessSnapshot): boolean;
    private sign;
    private gatherSignals;
}
export declare function globalScore(s: CalibrationSignals): number;
export declare function perClassScores(s: CalibrationSignals): Readonly<Record<string, number>>;
//# sourceMappingURL=CalibrationService.d.ts.map