/**
 * PromptBudgetEnforcerAdapter — bridges ITokenBudget to infrastructure/PromptBudgetEnforcer.
 *
 * Accounting model (B1, v10.4): measurement-based post-flight accounting.
 *
 * 1. Pre-flight admission  — checks ceiling against per-phase cap + global budget.
 * 2. Post-flight accounting — prefers MeasuredResult<T>.tokensUsed (measurement path),
 *    falls back to PromptBudgetEnforcer 'tokens-consumed' event total during fn() window,
 *    then falls back to maxTokens estimate only as a last resort.
 * 3. OVER_CAP_USAGE warning logged when actual > maxTokens (non-blocking diagnostic).
 *
 * Constructor: enforcer is optional — pass undefined in tests / embedded use cases where
 * the existing infrastructure enforcer is unavailable (NoopTokenBudget is preferred there).
 */
import type { ITokenBudget } from '@oweibo/core-contracts';
import type { PromptBudgetEnforcer } from '../../infrastructure/PromptBudgetEnforcer.js';
import type { ILogger } from '../analysis/validateGlobPatterns.js';
export type { PromptBudgetEnforcer };
export interface MeasuredResult<T> {
    readonly value: T;
    readonly tokensUsed: number;
}
export declare const measured: <T>(value: T, tokensUsed: number) => MeasuredResult<T>;
export declare class PromptBudgetEnforcerAdapter implements ITokenBudget {
    private readonly enforcer;
    private readonly globalMaxTokens;
    private readonly perPhaseCaps;
    private readonly logger;
    private spent;
    private readonly phaseSpent;
    /**
     * @param enforcer        Optional wrapped infrastructure enforcer. When provided,
     *                        the adapter subscribes to its 'tokens-consumed' event during
     *                        each withinBudget() call as a fallback measurement source (B1).
     * @param globalMaxTokens Hard cap across the entire run. Default: 80 000 tokens.
     * @param perPhaseCaps    Optional per-phase caps (phase name → max tokens).
     * @param logger          Receives OVER_CAP_USAGE warnings. Default: no-op.
     */
    constructor(enforcer: PromptBudgetEnforcer | undefined, globalMaxTokens?: number, perPhaseCaps?: Record<string, number>, logger?: ILogger);
    withinBudget<T>(phase: string, maxTokens: number, fn: () => Promise<T | MeasuredResult<T>>): Promise<T>;
    remaining(): number;
    /** Total tokens consumed across all phases this run. Used by DocGeneratorWorker (C14). */
    get totalSpent(): number;
}
//# sourceMappingURL=PromptBudgetEnforcerAdapter.d.ts.map