"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoopTokenBudget = exports.BudgetExhaustedError = void 0;
/** Thrown when a phase would exceed either per-phase cap or global budget. */
class BudgetExhaustedError extends Error {
    phase;
    requested;
    constructor(phase, requested) {
        super(`[ITokenBudget] Phase '${phase}' would exceed budget (requested ${requested} tokens)`);
        this.phase = phase;
        this.requested = requested;
        this.name = 'BudgetExhaustedError';
    }
}
exports.BudgetExhaustedError = BudgetExhaustedError;
/** No-op implementation — no limits; for tests and non-LLM (structural-only) runs. */
class NoopTokenBudget {
    async withinBudget(_phase, _max, fn) {
        return fn();
    }
    remaining() { return Infinity; }
}
exports.NoopTokenBudget = NoopTokenBudget;
//# sourceMappingURL=ITokenBudget.js.map