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

export type SafePattern =
  | 'read-only-analysis'
  | 'test-execution'
  | 'lint-check'
  | 'type-check'
  | 'documentation-generation'
  | 'repo-indexing'
  | 'dependency-audit';

const SAFE_PATTERNS: Set<SafePattern> = new Set([
  'read-only-analysis',
  'test-execution',
  'lint-check',
  'type-check',
  'documentation-generation',
  'repo-indexing',
  'dependency-audit',
]);

export class AsyncHITLCoordinator {
  private readonly pendingEscalations = new Map<string, string>(); // taskId:stageId → requestId

  constructor(
    private readonly hitl: HITLGateway,
    private readonly redis: Redis,
  ) {}

  isSafePattern(pattern: string): boolean {
    return SAFE_PATTERNS.has(pattern as SafePattern);
  }

  async escalateIfNeeded(escalation: HITLEscalation): Promise<{ requiresWait: boolean; requestId?: string }> {
    // Safe patterns never need HITL
    if (this.isSafePattern(escalation.stageId)) {
      return { requiresWait: false };
    }

    // Check if already escalated for this task+stage
    const key = `${escalation.taskId}:${escalation.stageId}`;
    const existing = this.pendingEscalations.get(key);
    if (existing) {
      return { requiresWait: true, requestId: existing };
    }

    const requestId = await this.hitl.escalate({
      taskId: escalation.taskId,
      agentId: escalation.agentId,
      message: {
        id: `hitl-${Date.now()}`,
        from: escalation.agentId,
        to: 'human',
        type: 'escalate',
        payload: escalation.payload,
        traceId: escalation.taskId,
        timestamp: Date.now(),
      },
      reason: escalation.reason,
      escalatedAt: Date.now(),
    });

    this.pendingEscalations.set(key, requestId);

    // Non-blocking escalations let the pipeline continue
    if (!escalation.blocking) {
      return { requiresWait: false, requestId };
    }

    return { requiresWait: true, requestId };
  }

  async waitForApproval(requestId: string, timeoutMs = 300_000): Promise<StoredHITLRequest> {
    return this.hitl.waitForDecision(requestId, timeoutMs);
  }

  async getDecisionIfReady(requestId: string): Promise<StoredHITLRequest | null> {
    // Non-blocking check — returns null if still pending
    const raw = await this.redis.hget(`hitl:${requestId}`, 'data');
    if (!raw) return null;
    const request = JSON.parse(raw) as StoredHITLRequest;
    return request.status !== 'pending' ? request : null;
  }

  clearEscalation(taskId: string, stageId: string): void {
    this.pendingEscalations.delete(`${taskId}:${stageId}`);
  }
}
