/**
 * SelfCorrectionLoop — meta-reasoning self-correction loop (§16b).
 *
 * Wraps stage execution with automatic retry, context augmentation,
 * and strategy pivoting. Integrates with EntropyTracker to detect
 * when the system is stuck and needs an Architect Reset.
 */
import type { ILLMClient } from '@oweibo/core-contracts';
import type { EntropyTracker } from './EntropyTracker.js';
import type { RecoveryOrchestrator } from '../recovery/RecoveryOrchestrator.js';
export interface CorrectionAttempt {
    readonly attempt: number;
    readonly stageId: string;
    readonly error: string;
    readonly correction: string;
    readonly timestamp: number;
}
export interface SelfCorrectionConfig {
    readonly maxAttempts: number;
    readonly enableLLMReflection: boolean;
    readonly reflectionModelTier: 'small' | 'medium' | 'large';
}
export declare class SelfCorrectionLoop {
    private readonly entropy;
    private readonly recovery;
    private readonly llm;
    private readonly attempts;
    private readonly config;
    constructor(entropy: EntropyTracker, recovery: RecoveryOrchestrator, llm: ILLMClient | null, config?: Partial<SelfCorrectionConfig>);
    executeWithCorrection<T>(stageId: string, taskId: string, originalPrompt: string, execute: (prompt: string) => Promise<T>, validate: (result: T) => {
        valid: boolean;
        error?: string;
    }): Promise<{
        result: T;
        attempts: number;
        corrections: CorrectionAttempt[];
    }>;
    private handleEntropyViolation;
    private generateCorrection;
}
//# sourceMappingURL=SelfCorrectionLoop.d.ts.map