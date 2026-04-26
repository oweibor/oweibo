/**
 * HITLGateway — Human-In-The-Loop escalation gateway (§16d, §5b.4).
 *
 * Publishes HITL requests to a Redis stream for human review.
 * Supports approval, rejection, and listing of pending requests.
 * Integrates with TaskEventBus to notify when HITL decisions are made.
 */
import type { AgentMessage } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
export interface HITLRequest {
    taskId: string;
    agentId: string;
    message: AgentMessage;
    reason: string;
    escalatedAt: number;
}
export interface StoredHITLRequest extends HITLRequest {
    requestId: string;
    status: 'pending' | 'approved' | 'rejected';
    decidedAt?: number;
    decidedBy?: string;
    decisionReason?: string;
    modifications?: Record<string, unknown>;
}
export declare class HITLGateway {
    private readonly redis;
    constructor(redis: Redis);
    escalate(request: HITLRequest): Promise<string>;
    approve(requestId: string, decision: {
        reason?: string;
        modifications?: Record<string, unknown>;
        userId?: string;
    }): Promise<void>;
    reject(requestId: string, decision: {
        reason?: string;
        userId?: string;
    }): Promise<void>;
    listPending(tenantId?: string): Promise<StoredHITLRequest[]>;
    waitForDecision(requestId: string, timeoutMs?: number): Promise<StoredHITLRequest>;
    private getRequest;
}
//# sourceMappingURL=HITLGateway.d.ts.map