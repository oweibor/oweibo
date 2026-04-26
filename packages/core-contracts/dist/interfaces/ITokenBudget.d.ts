/**
 * ITokenBudget — phase-scoped token budget enforcement for the doc-generator.
 *
 * Decouples doc-generator/ from infrastructure/PromptBudgetEnforcer. The concrete
 * PromptBudgetEnforcerAdapter lives in core-engine/doc-generator/adapters/ and wraps
 * the infrastructure copy. NoopTokenBudget lives here for tests and embedded use.
 *
 * Accounting model (B1, v10.4): withinBudget() uses measurement-based post-flight
 * accounting, not reservation-based. See PromptBudgetEnforcerAdapter for details.
 */
export interface ITokenBudget {
    /**
     * Run fn() if the estimated token cost is within the phase's budget.
     * Throws BudgetExhaustedError if the phase cap would be exceeded.
     *
     * @param phase     - Stable identifier (e.g. 'doc-project-summary').
     * @param maxTokens - Upper bound for this call's estimated input tokens.
     * @param fn        - Async operation to run within budget.
     */
    withinBudget<T>(phase: string, maxTokens: number, fn: () => Promise<T>): Promise<T>;
    /** Returns remaining tokens for the run, or Infinity if unbounded. */
    remaining(): number;
}
/** Thrown when a phase would exceed either per-phase cap or global budget. */
export declare class BudgetExhaustedError extends Error {
    readonly phase: string;
    readonly requested: number;
    constructor(phase: string, requested: number);
}
/** No-op implementation — no limits; for tests and non-LLM (structural-only) runs. */
export declare class NoopTokenBudget implements ITokenBudget {
    withinBudget<T>(_phase: string, _max: number, fn: () => Promise<T>): Promise<T>;
    remaining(): number;
}
//# sourceMappingURL=ITokenBudget.d.ts.map