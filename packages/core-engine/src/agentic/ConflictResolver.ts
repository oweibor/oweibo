// packages/core-engine/src/agentic/ConflictResolver.ts
// Arbitration between executor and reviewer disagreements (§16d.4)
import { randomUUID } from 'crypto';
import type { AgentMessage, ISecurityContext } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import type { HITLGateway } from '../governance/HITLGateway.js';

export interface ConflictResolution {
  accepted:       boolean;
  acceptedOutput: unknown;
  messages:       AgentMessage[];
}

/**
 * ConflictResolver — mediates between executor and reviewer when a challenge is raised.
 * If resolution cannot be reached, escalates to HITLGateway.
 */
export class ConflictResolver {
  constructor(private readonly hitl: HITLGateway) {}


  async resolve(
    taskId:          string,
    executorMsg:     AgentMessage,
    reviewerMsg:     AgentMessage,
    secCtx:          ISecurityContext,
    trace:           LangfuseTraceClient,
  ): Promise<ConflictResolution> {
    const messages: AgentMessage[] = [];

    // Attempt 1: Accept reviewer's challenge — return the reviewer-corrected output if present
    const correctedOutput = (reviewerMsg.payload as Record<string, unknown>)?.['correctedOutput'];
    if (correctedOutput !== undefined) {
      const resolution: AgentMessage = {
        id:        randomUUID(),
        from:      'conflict-resolver',
        to:        'orchestrator',
        type:      'consensus',
        payload:   { resolution: 'reviewer-correction-accepted', output: correctedOutput },
        traceId:   trace.id,
        timestamp: Date.now(),
      };
      messages.push(resolution);
      return { accepted: true, acceptedOutput: correctedOutput, messages };
    }

    // Attempt 2: Accept executor's output (reviewer's challenge is non-blocking)
    const challenge = (reviewerMsg.payload as Record<string, unknown>)?.['severity'];
    if (challenge !== 'blocking') {
      const resolution: AgentMessage = {
        id:        randomUUID(),
        from:      'conflict-resolver',
        to:        'orchestrator',
        type:      'consensus',
        payload:   { resolution: 'executor-output-accepted-non-blocking-challenge', output: executorMsg.payload },
        traceId:   trace.id,
        timestamp: Date.now(),
      };
      messages.push(resolution);
      return { accepted: true, acceptedOutput: executorMsg.payload, messages };
    }

    // Blocking conflict — escalate to HITL
    await this.hitl.escalate({
      taskId,
      agentId:     executorMsg.from,
      message:     reviewerMsg,
      reason:      'blocking-review-challenge',
      escalatedAt: Date.now(),
    });

    const escalationMsg: AgentMessage = {
      id:        randomUUID(),
      from:      'conflict-resolver',
      to:        'orchestrator',
      type:      'challenge',
      payload:   { resolution: 'escalated-to-hitl', challenge: reviewerMsg.payload },
      traceId:   trace.id,
      timestamp: Date.now(),
    };
    messages.push(escalationMsg);
    return { accepted: false, acceptedOutput: null, messages };
  }
}
