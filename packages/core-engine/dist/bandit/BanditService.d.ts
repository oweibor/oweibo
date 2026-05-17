import type { Pool } from 'pg';
import type { CanonicalRole } from '@oweibo/core-contracts';
import type { OperationalModeService } from '../infrastructure/OperationalModeService.js';
export interface BanditArm {
    readonly id: string;
    readonly promptHash: string;
    readonly slotId: string;
    readonly channel: string;
    /** Thompson sampling parameters — Beta(alpha, beta). */
    alpha: number;
    beta: number;
}
export interface DrawResult {
    readonly armId: string;
    readonly promptHash: string;
    readonly channel: string;
}
export interface BanditReward {
    readonly taskId: string;
    readonly slotId: string;
    readonly armId: string;
    readonly reward: number;
}
export declare class BanditService {
    private readonly pool;
    /** Optional: enforces §17.5.1 mode checks on reward recording and promotion. */
    private readonly operationalMode?;
    constructor(pool: Pool, 
    /** Optional: enforces §17.5.1 mode checks on reward recording and promotion. */
    operationalMode?: OperationalModeService | undefined);
    /**
     * Draw an arm for a given (slotId, channel) using Thompson sampling.
     * 5% of draws are forced exploration (random arm selection).
     *
     * @param rngSeed Deterministic seed — used for resumed tasks (rng is seeded by taskId+slotId).
     */
    draw(params: {
        slotId: string;
        channel: string;
        role: CanonicalRole;
        rngSeed?: number;
    }): Promise<DrawResult>;
    /**
     * Record a reward and update arm parameters.
     * Idempotent: uses bandit_arm_events dedup table (closes E-03).
     * §17.5.1 Mode ≤ 3: bandit learning is paused — returns silently without recording.
     */
    recordReward(reward: BanditReward): Promise<void>;
    private loadArms;
    /**
     * Update channel pointer atomically with optimistic lock (closes E-04).
     * Fails if version has been updated concurrently.
     * §17.5.1 Mode ≤ 1: promotions are frozen — throws OperationDisabledError.
     */
    promoteArm(params: {
        role: CanonicalRole;
        slotId: string;
        channel: string;
        promptHash: string;
        currentVersion: bigint;
        updatedBy: string;
    }): Promise<boolean>;
}
//# sourceMappingURL=BanditService.d.ts.map