"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelfCorrectionLoop = void 0;
const DEFAULT_CONFIG = {
    maxAttempts: 3,
    enableLLMReflection: true,
    reflectionModelTier: 'small',
};
class SelfCorrectionLoop {
    entropy;
    recovery;
    llm;
    attempts = [];
    config;
    constructor(entropy, recovery, llm, config = {}) {
        this.entropy = entropy;
        this.recovery = recovery;
        this.llm = llm;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    async executeWithCorrection(stageId, taskId, originalPrompt, execute, validate) {
        let currentPrompt = originalPrompt;
        let lastError = '';
        for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
            try {
                const result = await execute(currentPrompt);
                const validation = validate(result);
                if (validation.valid) {
                    await this.entropy.recordSuccess(stageId);
                    return { result, attempts: attempt, corrections: [...this.attempts] };
                }
                lastError = validation.error ?? 'Validation failed';
                const violation = await this.entropy.recordFailure(stageId, lastError);
                if (violation) {
                    return this.handleEntropyViolation(violation, stageId, taskId, currentPrompt, execute);
                }
                // Generate corrective prompt
                const correction = await this.generateCorrection(stageId, lastError, currentPrompt, attempt);
                this.attempts.push({
                    attempt,
                    stageId,
                    error: lastError,
                    correction: correction.slice(0, 200),
                    timestamp: Date.now(),
                });
                currentPrompt = correction;
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                const violation = await this.entropy.recordFailure(stageId, lastError);
                if (violation) {
                    return this.handleEntropyViolation(violation, stageId, taskId, currentPrompt, execute);
                }
            }
        }
        throw new Error(`[SelfCorrectionLoop] Stage "${stageId}" failed after ${this.config.maxAttempts} attempts. ` +
            `Last error: ${lastError}`);
    }
    async handleEntropyViolation(violation, stageId, taskId, currentPrompt, execute) {
        const resetContext = this.entropy.buildResetContext(violation);
        if (violation.recommendation === 'human-escalation') {
            throw new Error(`[SelfCorrectionLoop] Entropy limit reached for "${stageId}". ` +
                `${violation.attempts} attempts with same error pattern. Escalating to HITL.`);
        }
        // For architect-reset and strategy-pivot, throw with reset context
        throw new Error(`[SelfCorrectionLoop:${violation.recommendation}] ${resetContext}`);
    }
    async generateCorrection(stageId, error, originalPrompt, attempt) {
        if (!this.config.enableLLMReflection || !this.llm) {
            return `${originalPrompt}\n\n[Attempt ${attempt} correction] Previous error: ${error}\nPlease fix the issue and try again.`;
        }
        const reflection = await this.llm.generate({
            systemPrompt: 'You are a code quality reviewer. Analyze the error and suggest a corrective approach. Be concise.',
            userPrompt: `Stage: ${stageId}\nAttempt: ${attempt}\nError: ${error}\n\nOriginal instruction:\n${originalPrompt.slice(0, 2000)}`,
            temperature: 0.1,
            maxTokens: 500,
        });
        return `${originalPrompt}\n\n[Self-correction — attempt ${attempt}]\nPrevious error: ${error}\nCorrection guidance: ${reflection.output}`;
    }
}
exports.SelfCorrectionLoop = SelfCorrectionLoop;
//# sourceMappingURL=SelfCorrectionLoop.js.map