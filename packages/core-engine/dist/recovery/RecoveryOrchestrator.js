"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecoveryOrchestrator = void 0;
class RecoveryOrchestrator {
    breakers;
    hitl;
    constructor(breakers, hitl) {
        this.breakers = breakers;
        this.hitl = hitl;
    }
    getBreaker(stageId) {
        return this.breakers.get(stageId);
    }
    async handleFailure(error, context) {
        const breaker = this.breakers.get(context.stageId);
        if (!breaker) {
            return { action: 'abort', reason: `No circuit breaker for stage ${context.stageId}` };
        }
        const recovery = await breaker.recordFailure(error);
        return this.executeRecovery(recovery, context);
    }
    async recordSuccess(stageId) {
        const breaker = this.breakers.get(stageId);
        if (breaker) {
            await breaker.recordSuccess();
        }
    }
    async executeRecovery(recovery, context) {
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
                const request = {
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
    buildResetPrompt(context, recovery) {
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
exports.RecoveryOrchestrator = RecoveryOrchestrator;
//# sourceMappingURL=RecoveryOrchestrator.js.map