/**
 * S.3: GenericWebhookRollbackAdapter — POSTs a JSON payload to a
 * tenant-configured webhook URL with an HMAC-signed body. Used for
 * custom integrations (compensating-action systems, PagerDuty
 * "incident-resolved" hooks, internal escalation workflow tools).
 *
 * This adapter ships as a *stub* that returns `failed` until the
 * tenant-side webhook config + HMAC secret resolution is wired through
 * the connector library (T.2.f). The contract is stable; only the
 * dispatch implementation is deferred.
 *
 * The orchestrator records the result either way, so the operator UI
 * can show "webhook adapter not wired" with the same shape it shows
 * adapter failures from real integrations.
 */
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

export interface WebhookConfig {
  readonly url: string;
  readonly hmacSecret: string;
}

export interface WebhookConfigResolver {
  /** Returns the tenant's configured webhook destination, or null if none. */
  resolve(tenantId: string): Promise<WebhookConfig | null>;
}

export class GenericWebhookRollbackAdapter implements IRollbackAdapter {
  readonly name = 'webhook';

  constructor(private readonly resolver?: WebhookConfigResolver) {}

  async preflight(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<void> {
    if (!this.resolver) {
      throw new Error('webhook adapter has no config resolver wired');
    }
    const cfg = await this.resolver.resolve(ctx.tenantId);
    if (!cfg) {
      throw new Error(`no webhook URL configured for tenant ${ctx.tenantId}`);
    }
    void envelope;
  }

  async execute(_envelope: RollbackEnvelope, _ctx: RollbackContext): Promise<RollbackResult> {
    // Dispatch path deferred — see file header. Adapter MUST never
    // claim success when the dispatch hasn't been verified.
    return {
      success: false,
      state: 'failed',
      details: 'webhook adapter dispatch not yet implemented (S.3 stub)',
      sideEffects: [],
      costUsdCents: 0,
    };
  }
}
