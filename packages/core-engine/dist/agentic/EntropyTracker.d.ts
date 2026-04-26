/**
 * EntropyTracker — Rule-of-3 entropy detection + Architect Reset (§16e, G17).
 *
 * Monitors pipeline stage outcomes. When the same stage fails 3 times in a row
 * with semantically similar errors, the system is stuck in a self-correction loop.
 * EntropyTracker triggers an Architect Reset — discards the current plan and
 * re-enters the Architect stage with augmented context explaining the failure pattern.
 */
import type { Redis } from 'ioredis';
export interface EntropyEntry {
    readonly stageId: string;
    readonly attempt: number;
    readonly errorSignature: string;
    readonly timestamp: number;
}
export interface EntropyViolation {
    readonly stageId: string;
    readonly attempts: number;
    readonly errorPattern: string;
    readonly recommendation: 'architect-reset' | 'strategy-pivot' | 'human-escalation';
}
export declare class EntropyTracker {
    private readonly redis;
    private readonly taskId;
    private readonly entries;
    constructor(redis: Redis, taskId: string);
    recordFailure(stageId: string, errorMessage: string): Promise<EntropyViolation | null>;
    recordSuccess(stageId: string): Promise<void>;
    getFailureCount(stageId: string): Promise<number>;
    reset(): Promise<void>;
    buildResetContext(violation: EntropyViolation): string;
    private detectViolation;
    private computeErrorSignature;
    private isSimilar;
}
//# sourceMappingURL=EntropyTracker.d.ts.map