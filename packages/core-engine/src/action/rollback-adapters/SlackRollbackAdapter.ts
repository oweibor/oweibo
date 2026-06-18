/**
 * F.2.2 — SlackRollbackAdapter.
 *
 * Rolls back `comm.external_message` actions sent through Slack. Slack
 * does NOT support a true "delete" via bot tokens for messages the bot
 * didn't own; we instead post a retraction follow-up to the same channel
 * threaded against the original message.
 *
 * RollbackEnvelope.rollbackPlan shape:
 *
 *   {
 *     channelId:      string;             // Slack channel/IM/group id
 *     messageTs:      string;             // ts of the original message (used as thread_ts)
 *     originalText?:  string;             // optional, quoted in the retraction body
 *     retractionText?: string;            // override default text
 *     oauthSecretKid?: string;            // SecretsManager path override; else uses default tenant config
 *   }
 *
 * Bot token: resolved via the same per-tenant config + SecretsManager
 * path used by SlackChannel (F.1.3) — the resolver is injected so this
 * adapter doesn't reach into the Pg row directly.
 *
 * Preflight refuses when:
 *   - envelope.kind === 'irreversible'
 *   - rollbackPlan missing or channelId/messageTs absent
 *   - resolver returns no token for the tenant
 *
 * Execute behaviour:
 *   - posts a thread reply via chat.postMessage with thread_ts.
 *   - failure surfaces as state='failed' with the Slack API error.
 *   - never throws.
 */
import type {
  IRollbackAdapter,
  RollbackContext,
  RollbackEnvelope,
  RollbackResult,
} from '@oweibo/core-contracts';

const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';

interface SlackRollbackPlan {
  readonly channelId: string;
  readonly messageTs: string;
  readonly originalText?: string;
  readonly retractionText?: string;
  readonly oauthSecretKid?: string;
}

/**
 * Resolver returns the bot token for a tenant. Production wires this to
 * the SlackChannel's tenant_notification_channel_config row + SecretsManager.
 * Returning null = no token configured = adapter fails preflight.
 */
export interface SlackTokenResolver {
  resolve(tenantId: string, override?: { oauthSecretKid?: string }): Promise<string | null>;
}

export interface SlackRollbackAdapterOptions {
  /** Override for testing. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 10 000. */
  readonly timeoutMs?: number;
}

interface SlackApiResponse {
  readonly ok: boolean;
  readonly ts?: string;
  readonly error?: string;
}

export class SlackRollbackAdapter implements IRollbackAdapter {
  readonly name = 'slack';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly tokens: SlackTokenResolver,
    opts: SlackRollbackAdapterOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl
      ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async preflight(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<void> {
    if (envelope.kind === 'irreversible') {
      throw new Error('slack rollback: envelope.kind=irreversible');
    }
    const plan = envelope.rollbackPlan as SlackRollbackPlan | undefined;
    if (!plan || typeof plan !== 'object') {
      throw new Error('slack rollback: missing rollbackPlan');
    }
    if (typeof plan.channelId !== 'string' || plan.channelId.length === 0) {
      throw new Error('slack rollback: rollbackPlan.channelId missing');
    }
    if (typeof plan.messageTs !== 'string' || plan.messageTs.length === 0) {
      throw new Error('slack rollback: rollbackPlan.messageTs missing');
    }
    const override = plan.oauthSecretKid !== undefined ? { oauthSecretKid: plan.oauthSecretKid } : undefined;
    const token = await this.tokens.resolve(ctx.tenantId, override);
    if (!token) {
      throw new Error('slack rollback: no token configured for tenant');
    }
  }

  async execute(envelope: RollbackEnvelope, ctx: RollbackContext): Promise<RollbackResult> {
    if (!this.fetchImpl) {
      return failed('slack rollback: no fetch implementation (Node < 18?)');
    }
    const plan = envelope.rollbackPlan as SlackRollbackPlan;
    let token: string | null;
    try {
      const override = plan.oauthSecretKid !== undefined ? { oauthSecretKid: plan.oauthSecretKid } : undefined;
      token = await this.tokens.resolve(ctx.tenantId, override);
    } catch (err) {
      return failed(`slack rollback: token lookup failed: ${describeError(err)}`);
    }
    if (!token) return failed('slack rollback: no token configured');

    const text = plan.retractionText ?? defaultRetraction(plan.originalText);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    timer.unref?.();
    let res: Response;
    try {
      res = await this.fetchImpl(SLACK_POST_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel:   plan.channelId,
          thread_ts: plan.messageTs,
          text,
        }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return failed(`slack rollback: fetch failed: ${describeError(err)}`);
    }
    clearTimeout(timer);

    if (!res.ok) return failed(`slack rollback: HTTP ${res.status}`);
    let body: SlackApiResponse;
    try {
      body = await res.json() as SlackApiResponse;
    } catch (err) {
      return failed(`slack rollback: malformed JSON: ${describeError(err)}`);
    }
    if (!body.ok) return failed(`slack rollback: api error: ${body.error ?? 'unknown'}`);
    return {
      success: true,
      state: 'fully_reverted',
      details: 'retraction follow-up posted',
      sideEffects: body.ts ? [`slack.retraction_ts=${body.ts}`] : [],
      costUsdCents: 0,
    };
  }
}

function defaultRetraction(originalText: string | undefined): string {
  if (!originalText) return ':warning: This message was retracted.';
  return `:warning: The previous message ("${truncate(originalText, 120)}") was retracted.`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failed(details: string): RollbackResult {
  return { success: false, state: 'failed', details, sideEffects: [], costUsdCents: 0 };
}
