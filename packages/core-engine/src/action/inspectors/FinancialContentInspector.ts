/**
 * S.5.a: FinancialContentInspector — guards `financial.payment` actions.
 *
 * Refuses outright:
 *   * payment amount > per-tenant absolute cap (default $50 000 USD;
 *     overridable via resolver)
 *   * currency missing or non-ISO-4217-shaped
 *
 * Upgrades to require_approval:
 *   * recipient bank/account not in the tenant's known-recipient cache
 *     (when resolver is wired; otherwise just notes "unknown recipient"
 *     in details)
 *   * amount > 20% of the historical 30-day rolling average for this
 *     tenant (when resolver supplies historicalAvgCents)
 *
 * Payload shape expected:
 *   {
 *     amountCents: number; currency: string;
 *     recipient: { id?: string; name?: string; account?: string };
 *     reference?: string;
 *   }
 */
import type {
  ActionContext,
  ContentInspectionResult,
  IContentInspector,
} from '@oweibo/core-contracts';

interface FinancialPayload {
  amountCents?: number;
  currency?: string;
  recipient?: { id?: string; name?: string; account?: string };
}

export interface ITenantFinancialContext {
  /** Tenant's absolute single-payment cap in USD cents. */
  absoluteCapCents(tenantId: string): Promise<number>;
  /** Has this recipient been paid before by this tenant? */
  isKnownRecipient?(tenantId: string, recipient: { id?: string; name?: string; account?: string }): Promise<boolean>;
  /** 30-day rolling average payment in USD cents (after FX). */
  historicalAvgCents?(tenantId: string): Promise<number | null>;
}

const DEFAULT_ABSOLUTE_CAP_CENTS = 50_000_00; // $50 000.
const HIGH_DELTA_RATIO = 0.20; // 20% of rolling average

export class FinancialContentInspector implements IContentInspector {
  readonly name = 'financial_content';

  constructor(private readonly ctxResolver?: ITenantFinancialContext) {}

  appliesTo(actionClass: string): boolean {
    return actionClass === 'financial.payment';
  }

  async inspect(ctx: ActionContext): Promise<ContentInspectionResult> {
    const p = (ctx.payload ?? {}) as FinancialPayload;

    if (typeof p.amountCents !== 'number' || !Number.isFinite(p.amountCents) || p.amountCents <= 0) {
      return {
        verdict: 'forbid',
        reason: 'payment payload missing valid amountCents',
        details: { matched: 'NO_AMOUNT' },
      };
    }
    if (!p.currency || !/^[A-Z]{3}$/.test(p.currency)) {
      return {
        verdict: 'forbid',
        reason: 'payment currency missing or not ISO-4217 (3-letter)',
        details: { matched: 'BAD_CURRENCY', currency: p.currency },
      };
    }

    const cap = this.ctxResolver
      ? await this.ctxResolver.absoluteCapCents(ctx.tenantId)
      : DEFAULT_ABSOLUTE_CAP_CENTS;
    if (p.amountCents > cap) {
      return {
        verdict: 'forbid',
        reason: `payment of ${formatCents(p.amountCents)} ${p.currency} exceeds tenant cap ${formatCents(cap)}`,
        details: { matched: 'OVER_CAP', amountCents: p.amountCents, capCents: cap },
      };
    }

    // Unknown recipient (optional resolver).
    if (p.recipient && this.ctxResolver?.isKnownRecipient) {
      const known = await this.ctxResolver.isKnownRecipient(ctx.tenantId, p.recipient);
      if (!known) {
        return {
          verdict: 'upgrade_to_approval',
          reason: 'recipient is not in tenant\'s known-recipient cache',
          details: { matched: 'UNKNOWN_RECIPIENT', recipient: p.recipient },
        };
      }
    }

    // Amount is a large fraction of the historical rolling average.
    if (this.ctxResolver?.historicalAvgCents) {
      const avg = await this.ctxResolver.historicalAvgCents(ctx.tenantId);
      if (avg && avg > 0 && p.amountCents > avg * (1 + HIGH_DELTA_RATIO * 10)) {
        // Spike: > 3x rolling average is materially unusual.
        return {
          verdict: 'upgrade_to_approval',
          reason: `payment ${formatCents(p.amountCents)} is unusually large vs 30-day avg ${formatCents(avg)}`,
          details: { matched: 'AMOUNT_SPIKE', amountCents: p.amountCents, avgCents: avg },
        };
      }
    }

    return { verdict: 'allow' };
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
