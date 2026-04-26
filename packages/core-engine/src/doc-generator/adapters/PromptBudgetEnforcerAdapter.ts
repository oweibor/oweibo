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
import { BudgetExhaustedError } from '@oweibo/core-contracts';
import type { PromptBudgetEnforcer } from '../../infrastructure/PromptBudgetEnforcer.js';
import type { ILogger } from '../analysis/validateGlobPatterns.js';

export type { PromptBudgetEnforcer };

// ── MeasuredResult ─────────────────────────────────────────────────────────────

export interface MeasuredResult<T> {
  readonly value:      T;
  readonly tokensUsed: number;
}

export const measured = <T>(value: T, tokensUsed: number): MeasuredResult<T> =>
  ({ value, tokensUsed });

// ── NullLogger ─────────────────────────────────────────────────────────────────

class NullLogger implements ILogger {
  info  (): void { /* noop */ }
  warn  (): void { /* noop */ }
  error (): void { /* noop */ }
  debug (): void { /* noop */ }
}

// ── PromptBudgetEnforcerAdapter ────────────────────────────────────────────────

export class PromptBudgetEnforcerAdapter implements ITokenBudget {
  private spent = 0;
  private readonly phaseSpent = new Map<string, number>();

  /**
   * @param enforcer        Optional wrapped infrastructure enforcer. When provided,
   *                        the adapter subscribes to its 'tokens-consumed' event during
   *                        each withinBudget() call as a fallback measurement source (B1).
   * @param globalMaxTokens Hard cap across the entire run. Default: 80 000 tokens.
   * @param perPhaseCaps    Optional per-phase caps (phase name → max tokens).
   * @param logger          Receives OVER_CAP_USAGE warnings. Default: no-op.
   */
  constructor(
    private readonly enforcer:        PromptBudgetEnforcer | undefined,
    private readonly globalMaxTokens: number = 80_000,
    private readonly perPhaseCaps:    Record<string, number> = {},
    private readonly logger:          ILogger = new NullLogger(),
  ) {}

  async withinBudget<T>(
    phase:     string,
    maxTokens: number,
    fn:        () => Promise<T | MeasuredResult<T>>,
  ): Promise<T> {
    // ── 1. Pre-flight admission ───────────────────────────────────────────────
    const perPhaseCap       = this.perPhaseCaps[phase] ?? Infinity;
    const phaseAlreadySpent = this.phaseSpent.get(phase) ?? 0;

    if (phaseAlreadySpent + maxTokens > perPhaseCap) {
      throw new BudgetExhaustedError(phase, maxTokens);
    }
    if (this.spent + maxTokens > this.globalMaxTokens) {
      throw new BudgetExhaustedError(phase, maxTokens);
    }

    // ── 2. Event-bus fallback: subscribe during fn() window (B1) ─────────────
    let eventTotal = 0;
    const onTokensConsumed = (n: number): void => { eventTotal += n; };
    if (this.enforcer) {
      this.enforcer.on('tokens-consumed', onTokensConsumed);
    }

    try {
      const raw = await fn();

      // ── 3. Reconciliation: measured > event > estimate ────────────────────
      const isMeasured =
        raw !== null &&
        typeof raw === 'object' &&
        'value'      in (raw as object) &&
        'tokensUsed' in (raw as object);

      const measuredTokens = isMeasured ? (raw as MeasuredResult<T>).tokensUsed : undefined;
      const actual = measuredTokens ?? (eventTotal > 0 ? eventTotal : maxTokens);

      if (actual > maxTokens) {
        this.logger.warn(
          `[PromptBudgetEnforcerAdapter] OVER_CAP_USAGE phase=${phase} actual=${actual} estimated=${maxTokens}`,
        );
      }

      this.spent += actual;
      this.phaseSpent.set(phase, phaseAlreadySpent + actual);

      return isMeasured ? (raw as MeasuredResult<T>).value : (raw as T);
    } finally {
      if (this.enforcer) {
        this.enforcer.off('tokens-consumed', onTokensConsumed);
      }
    }
  }

  remaining(): number { return Math.max(0, this.globalMaxTokens - this.spent); }

  /** Total tokens consumed across all phases this run. Used by DocGeneratorWorker (C14). */
  get totalSpent(): number { return this.spent; }
}
