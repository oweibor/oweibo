"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptBudgetEnforcerAdapter = exports.measured = void 0;
const core_contracts_1 = require("@oweibo/core-contracts");
const measured = (value, tokensUsed) => ({ value, tokensUsed });
exports.measured = measured;
// ── NullLogger ─────────────────────────────────────────────────────────────────
class NullLogger {
    info() { }
    warn() { }
    error() { }
    debug() { }
}
// ── PromptBudgetEnforcerAdapter ────────────────────────────────────────────────
class PromptBudgetEnforcerAdapter {
    enforcer;
    globalMaxTokens;
    perPhaseCaps;
    logger;
    spent = 0;
    phaseSpent = new Map();
    /**
     * @param enforcer        Optional wrapped infrastructure enforcer. When provided,
     *                        the adapter subscribes to its 'tokens-consumed' event during
     *                        each withinBudget() call as a fallback measurement source (B1).
     * @param globalMaxTokens Hard cap across the entire run. Default: 80 000 tokens.
     * @param perPhaseCaps    Optional per-phase caps (phase name → max tokens).
     * @param logger          Receives OVER_CAP_USAGE warnings. Default: no-op.
     */
    constructor(enforcer, globalMaxTokens = 80_000, perPhaseCaps = {}, logger = new NullLogger()) {
        this.enforcer = enforcer;
        this.globalMaxTokens = globalMaxTokens;
        this.perPhaseCaps = perPhaseCaps;
        this.logger = logger;
    }
    async withinBudget(phase, maxTokens, fn) {
        // ── 1. Pre-flight admission ───────────────────────────────────────────────
        const perPhaseCap = this.perPhaseCaps[phase] ?? Infinity;
        const phaseAlreadySpent = this.phaseSpent.get(phase) ?? 0;
        if (phaseAlreadySpent + maxTokens > perPhaseCap) {
            throw new core_contracts_1.BudgetExhaustedError(phase, maxTokens);
        }
        if (this.spent + maxTokens > this.globalMaxTokens) {
            throw new core_contracts_1.BudgetExhaustedError(phase, maxTokens);
        }
        // ── 2. Event-bus fallback: subscribe during fn() window (B1) ─────────────
        let eventTotal = 0;
        const onTokensConsumed = (n) => { eventTotal += n; };
        if (this.enforcer) {
            this.enforcer.on('tokens-consumed', onTokensConsumed);
        }
        try {
            const raw = await fn();
            // ── 3. Reconciliation: measured > event > estimate ────────────────────
            const isMeasured = raw !== null &&
                typeof raw === 'object' &&
                'value' in raw &&
                'tokensUsed' in raw;
            const measuredTokens = isMeasured ? raw.tokensUsed : undefined;
            const actual = measuredTokens ?? (eventTotal > 0 ? eventTotal : maxTokens);
            if (actual > maxTokens) {
                this.logger.warn(`[PromptBudgetEnforcerAdapter] OVER_CAP_USAGE phase=${phase} actual=${actual} estimated=${maxTokens}`);
            }
            this.spent += actual;
            this.phaseSpent.set(phase, phaseAlreadySpent + actual);
            return isMeasured ? raw.value : raw;
        }
        finally {
            if (this.enforcer) {
                this.enforcer.off('tokens-consumed', onTokensConsumed);
            }
        }
    }
    remaining() { return Math.max(0, this.globalMaxTokens - this.spent); }
    /** Total tokens consumed across all phases this run. Used by DocGeneratorWorker (C14). */
    get totalSpent() { return this.spent; }
}
exports.PromptBudgetEnforcerAdapter = PromptBudgetEnforcerAdapter;
//# sourceMappingURL=PromptBudgetEnforcerAdapter.js.map