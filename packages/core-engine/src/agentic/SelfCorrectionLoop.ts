/**
 * SelfCorrectionLoop — meta-reasoning self-correction loop (§16b).
 *
 * Wraps stage execution with automatic retry, context augmentation,
 * and strategy pivoting. Integrates with EntropyTracker to detect
 * when the system is stuck and needs an Architect Reset.
 */
import type { ILLMClient } from '@oweibo/core-contracts';
import type { EntropyTracker, EntropyViolation } from './EntropyTracker.js';
import type { RecoveryOrchestrator, RecoveryResult } from '../recovery/RecoveryOrchestrator.js';

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

const DEFAULT_CONFIG: SelfCorrectionConfig = {
  maxAttempts: 3,
  enableLLMReflection: true,
  reflectionModelTier: 'small',
};

export class SelfCorrectionLoop {
  private readonly attempts: CorrectionAttempt[] = [];
  private readonly config: SelfCorrectionConfig;

  constructor(
    private readonly entropy: EntropyTracker,
    private readonly recovery: RecoveryOrchestrator,
    private readonly llm: ILLMClient | null,
    config: Partial<SelfCorrectionConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async executeWithCorrection<T>(
    stageId: string,
    taskId: string,
    originalPrompt: string,
    execute: (prompt: string) => Promise<T>,
    validate: (result: T) => { valid: boolean; error?: string },
  ): Promise<{ result: T; attempts: number; corrections: CorrectionAttempt[] }> {
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
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const violation = await this.entropy.recordFailure(stageId, lastError);

        if (violation) {
          return this.handleEntropyViolation(violation, stageId, taskId, currentPrompt, execute);
        }
      }
    }

    throw new Error(
      `[SelfCorrectionLoop] Stage "${stageId}" failed after ${this.config.maxAttempts} attempts. ` +
      `Last error: ${lastError}`,
    );
  }

  private async handleEntropyViolation<T>(
    violation: EntropyViolation,
    stageId: string,
    taskId: string,
    currentPrompt: string,
    execute: (prompt: string) => Promise<T>,
  ): Promise<never> {
    const resetContext = this.entropy.buildResetContext(violation);

    if (violation.recommendation === 'human-escalation') {
      throw new Error(
        `[SelfCorrectionLoop] Entropy limit reached for "${stageId}". ` +
        `${violation.attempts} attempts with same error pattern. Escalating to HITL.`,
      );
    }

    // For architect-reset and strategy-pivot, throw with reset context
    throw new Error(
      `[SelfCorrectionLoop:${violation.recommendation}] ${resetContext}`,
    );
  }

  private async generateCorrection(
    stageId: string,
    error: string,
    originalPrompt: string,
    attempt: number,
  ): Promise<string> {
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
