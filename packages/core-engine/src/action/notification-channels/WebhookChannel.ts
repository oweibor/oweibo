/**
 * F.1.3 — WebhookChannel (production impl).
 *
 * Posts JSON to a tenant-configured webhook URL with an optional HMAC-SHA256
 * signature header. URL + secret are resolved via IWebhookConfigResolver
 * (PgWebhookConfigResolver in production, kind='notification').
 *
 * Request shape (always JSON):
 *   {
 *     "tenantId":      "<uuid>",
 *     "proposalId":    "<uuid>",
 *     "channelKind":   "webhook",
 *     "fireEvent":     "initial" | "escalation" | "expiry",
 *     "title":         "...",
 *     "body":          "...",
 *     "linkPath":      "...",
 *     "urgency":       "normal" | "urgent",
 *     "dispatchedAt":  "<iso>"
 *   }
 *
 * Headers when hmacSecret is set:
 *   X-Oweibo-Signature: v1=<hex HMAC-SHA256(secret, raw body)>
 *   X-Oweibo-Timestamp: <unix-ms> (also included to bind the signature to
 *                                  a request — receivers should reject
 *                                  signatures older than their own clock-skew
 *                                  window).
 *
 * Failure model: any non-2xx, any network error, any timeout → failed.
 * The channel never throws; the router will fall back to in_app.
 *
 * Tenant scoping: the per-tenant 'enabled' flag on
 * tenant_notification_channel_config (channel_kind='webhook') gates dispatch.
 * When the row is absent the channel falls back to "enabled" — the resolver
 * is the authoritative URL source, and absence of a URL is the actual gate.
 */
import type { Pool } from 'pg';
import { createHmac } from 'crypto';
import type {
  DispatchResult,
  INotificationChannel,
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';
import type { IWebhookConfigResolver } from '../PgWebhookConfigResolver.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const SIG_VERSION = 'v1';

export interface WebhookChannelOptions {
  /** Override for testing. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 15 000. */
  readonly timeoutMs?: number;
  /** Override clock; tests pin time. */
  readonly now?: () => Date;
}

export class WebhookChannel implements INotificationChannel {
  readonly kind = 'webhook' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    private readonly resolver: IWebhookConfigResolver,
    opts: WebhookChannelOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl
      ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.now = opts.now ?? (() => new Date());
  }

  async dispatch(req: NotificationDispatchRequest): Promise<DispatchResult> {
    if (!this.fetchImpl) {
      return { status: 'failed', error: 'webhook channel: no fetch implementation (Node < 18?)' };
    }
    if (!UUID_RE.test(req.tenantId)) {
      return { status: 'failed', error: 'webhook channel: invalid tenantId' };
    }

    try {
      const enabled = await this.tenantEnabled(req.tenantId);
      if (!enabled) {
        return { status: 'failed', error: 'webhook channel: disabled for this tenant' };
      }
    } catch (err) {
      return { status: 'failed', error: `webhook channel: enabled-flag lookup failed: ${describeError(err)}` };
    }

    let cfg;
    try {
      cfg = await this.resolver.resolve(req.tenantId, 'notification');
    } catch (err) {
      return { status: 'failed', error: `webhook channel: resolver failed: ${describeError(err)}` };
    }
    if (!cfg) {
      return { status: 'failed', error: 'webhook channel: tenant has no webhook configured' };
    }

    const dispatchedAt = this.now().toISOString();
    const payload = JSON.stringify({
      tenantId:     req.tenantId,
      proposalId:   req.proposalId,
      channelKind:  req.channelKind,
      fireEvent:    req.fireEvent,
      title:        req.title,
      body:         req.body,
      linkPath:     req.linkPath,
      urgency:      req.urgency,
      dispatchedAt,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Oweibo-Timestamp': String(this.now().getTime()),
    };
    if (cfg.hmacSecret) {
      const sig = createHmac('sha256', cfg.hmacSecret).update(payload).digest('hex');
      headers['X-Oweibo-Signature'] = `${SIG_VERSION}=${sig}`;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    timer.unref?.();

    let res: Response;
    try {
      res = await this.fetchImpl(cfg.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return { status: 'failed', error: `webhook channel: fetch failed: ${describeError(err)}` };
    }
    clearTimeout(timer);

    if (res.status >= 200 && res.status < 300) {
      return { status: 'delivered', dispatchedAt };
    }
    return { status: 'failed', error: `webhook channel: HTTP ${res.status}` };
  }

  private async tenantEnabled(tenantId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const r = await client.query<{ enabled: boolean }>(
        `SELECT enabled
           FROM oweibo.tenant_notification_channel_config
          WHERE tenant_id = $1::uuid AND channel_kind = 'webhook'`,
        [tenantId],
      );
      await client.query('COMMIT');
      if (r.rows.length === 0) return true;  // absent row → enabled (resolver is the URL gate)
      return r.rows[0]!.enabled !== false;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
