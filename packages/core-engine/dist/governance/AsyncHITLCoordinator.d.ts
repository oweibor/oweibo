/**
 * AsyncHITLCoordinator — non-blocking HITL escalation (§16d, Gap §6).
 *
 * Allows the pipeline to continue processing safe stages while waiting
 * for human approval on sensitive operations. Maintains a safe-pattern
 * whitelist of operations that can proceed without HITL.
 */
import type { HITLGateway, StoredHITLRequest } from './HITLGateway.js';
import type { Redis } from 'ioredis';
export interface HITLEscalation {
    readonly taskId: string;
    readonly stageId: string;
    readonly agentId: string;
    readonly reason: string;
    readonly payload: unknown;
    readonly blocking: boolean;
}
export type SafePattern = 'read-only-analysis' | 'test-execution' | 'lint-check' | 'type-check' | 'documentation-generation' | 'repo-indexing' | 'dependency-audit';
export declare class AsyncHITLCoordinator {
    private readonly hitl;
    private readonly redis;
    private readonly pendingEscalations;
    constructor(hitl: HITLGateway, redis: Redis);
    isSafePattern(pattern: string): boolean;
    escalateIfNeeded(escalation: HITLEscalation): Promise<{
        requiresWait: boolean;
        requestId?: string;
    }>;
    waitForApproval(requestId: string, timeoutMs?: number): Promise<StoredHITLRequest>;
    getDecisionIfReady(requestId: string): Promise<StoredHITLRequest | null>;
    clearEscalation(taskId: string, stageId: string): void;
}
//# sourceMappingURL=AsyncHITLCoordinator.d.ts.map