/**
 * RecoveryOrchestrator — coordinates circuit-breaker-driven recovery strategies (§5.4).
 *
 * When a pipeline stage fails, the circuit breaker determines the recovery strategy.
 * RecoveryOrchestrator executes that strategy: retry with delay, context reset,
 * architect re-plan, or human escalation via HITLGateway.
 */
import type { IRecoveryAction, IPipelineError } from '@oweibo/core-contracts';
import type { RedisCircuitBreaker } from './RedisCircuitBreaker.js';
import type { HITLGateway, HITLRequest } from '../governance/HITLGateway.js';

export interface RecoveryContext {
  readonly taskId: string;
  readonly stageId: string;
  readonly attempt: number;
  readonly originalPrompt: string;
  readonly previousOutputs: readonly string[];
}

export type RecoveryResult =
  | { action: 'retry'; augmentedPrompt: string; delayMs: number }
  | { action: 'replan'; reason: string }
  | { action: 'escalate'; reason: string }
  | { action: 'abort'; reason: string };

export class RecoveryOrchestrator {
  constructor(
    private readonly breakers: Map<string, RedisCircuitBreaker>,
    private readonly hitl: HITLGateway,
  ) {}

  getBreaker(stageId: string): RedisCircuitBreaker | undefined {
    return this.breakers.get(stageId);
  }

  async handleFailure(
    error: IPipelineError,
    context: RecoveryContext,
  ): Promise<RecoveryResult> {
    const breaker = this.breakers.get(context.stageId);
    if (!breaker) {
      return { action: 'abort', reason: `No circuit breaker for stage ${context.stageId}` };
    }

    const recovery = await breaker.recordFailure(error);
    return this.executeRecovery(recovery, context);
  }

  async recordSuccess(stageId: string): Promise<void> {
    const breaker = this.breakers.get(stageId);
    if (breaker) {
      await breaker.recordSuccess();
    }
  }

  private async executeRecovery(
    recovery: IRecoveryAction,
    context: RecoveryContext,
  ): Promise<RecoveryResult> {
    switch (recovery.strategy) {
      case 'retry':
        return {
          action: 'retry',
          augmentedPrompt: recovery.promptAugmentation
            ? `${recovery.promptAugmentation}\n\n${context.originalPrompt}`
            : context.originalPrompt,
          delayMs: recovery.delayMs ?? 1000,
        };

      case 'context-reset':
        return {
          action: 'retry',
          augmentedPrompt: this.buildResetPrompt(context, recovery),
          delayMs: recovery.delayMs ?? 2000,
        };

      case 'architect-replan':
        return { action: 'replan', reason: recovery.reason };

      case 'human-escalation': {
        const request: HITLRequest = {
          taskId: context.taskId,
          agentId: `recovery:${context.stageId}`,
          message: {
            id: `recovery-${context.taskId}-${context.attempt}`,
            from: 'recovery-orchestrator',
            to: 'human',
            type: 'escalate',
            payload: {
              stage: context.stageId,
              attempt: context.attempt,
              reason: recovery.reason,
            },
            traceId: context.taskId,
            timestamp: Date.now(),
          },
          reason: recovery.reason,
          escalatedAt: Date.now(),
        };
        await this.hitl.escalate(request);
        return { action: 'escalate', reason: recovery.reason };
      }

      default:
        return { action: 'abort', reason: `Unknown recovery strategy: ${recovery.strategy}` };
    }
  }

  private buildResetPrompt(context: RecoveryContext, recovery: IRecoveryAction): string {
    const parts = [
      'CONTEXT RESET: Previous attempts produced incorrect output.',
      recovery.promptAugmentation ?? '',
      'Ignore all previous outputs. Start fresh from the original requirement.',
      '',
      context.originalPrompt,
    ];
    return parts.filter(Boolean).join('\n');
  }
}
