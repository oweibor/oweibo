/**
 * RecoveryOrchestrator — coordinates circuit-breaker-driven recovery strategies (§5.4).
 *
 * When a pipeline stage fails, the circuit breaker determines the recovery strategy.
 * RecoveryOrchestrator executes that strategy: retry with delay, context reset,
 * architect re-plan, or human escalation via HITLGateway.
 */
import type { IPipelineError } from '@oweibo/core-contracts';
import type { RedisCircuitBreaker } from './RedisCircuitBreaker.js';
import type { HITLGateway } from '../governance/HITLGateway.js';
export interface RecoveryContext {
    readonly taskId: string;
    readonly stageId: string;
    readonly attempt: number;
    readonly originalPrompt: string;
    readonly previousOutputs: readonly string[];
}
export type RecoveryResult = {
    action: 'retry';
    augmentedPrompt: string;
    delayMs: number;
} | {
    action: 'replan';
    reason: string;
} | {
    action: 'escalate';
    reason: string;
} | {
    action: 'abort';
    reason: string;
};
export declare class RecoveryOrchestrator {
    private readonly breakers;
    private readonly hitl;
    constructor(breakers: Map<string, RedisCircuitBreaker>, hitl: HITLGateway);
    getBreaker(stageId: string): RedisCircuitBreaker | undefined;
    handleFailure(error: IPipelineError, context: RecoveryContext): Promise<RecoveryResult>;
    recordSuccess(stageId: string): Promise<void>;
    private executeRecovery;
    private buildResetPrompt;
}
//# sourceMappingURL=RecoveryOrchestrator.d.ts.map