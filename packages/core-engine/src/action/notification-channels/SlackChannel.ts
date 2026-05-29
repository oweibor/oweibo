/**
 * F.1.3 — SlackChannel (production impl).
 *
 * Posts to Slack's chat.postMessage Web API. Per-tenant Slack bot tokens
 * and target channel/user IDs come from oweibo.tenant_notification_channel_config
 * (channel_kind='slack') with the bot token resolved indirectly through
 * SecretsManager (config carries oauthSecretKid; the actual token lives
 * in Vault).
 *
 * Expected per-tenant config JSONB:
 *   {
 *     "channelId":      "C01234567",                 // Slack channel ID or user IM ID
 *     "oauthSecretKid": "infra/slack/tenant-abc"     // SecretsManager path to the bot token
 *   }
 *
 * dispatch behaviour:
 *   - delivered → Slack returned { ok: true } and a ts.
 *   - failed    → no config, missing token, network error, or { ok: false }.
 *   - The channel never throws; failures surface as { status: 'failed' }
 *     so the NotificationRouter can fall back to in_app.
 *
 * The channel never reads the recipientUserId — Slack routing is config-
 * driven (per-tenant channel ID), not per-user.
 */
import type { Pool } from 'pg';
import type {
  DispatchResult,
  INotificationChannel,
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';
import type { SecretsManager } from '../../secrets/SecretsManager.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';

interface TenantSlackConfig {
  readonly channelId?: string;
  readonly oauthSecretKid?: string;
}

interface SlackApiResponse {
  readonly ok: boolean;
  readonly ts?: string;
  readonly error?: string;
}

export interface SlackChannelOptions {
  /** Override for testing. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 10 000. */
  readonly timeoutMs?: number;
}

export class SlackChannel implements INotificationChannel {
  readonly kind = 'slack' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly pool: Pool,
    private readonly secrets: SecretsManager,
    opts: SlackChannelOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl
      ?? ((typeof fetch !== 'undefined' ? fetch : undefined) as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async dispatch(req: NotificationDispatchRequest): Promise<DispatchResult> {
    if (!this.fetchImpl) {
      return { status: 'failed', error: 'slack channel: no fetch implementation (Node < 18?)' };
    }

    let cfg: TenantSlackConfig | null;
    try {
      cfg = await this.loadTenantConfig(req.tenantId);
    } catch (err) {
      return { status: 'failed', error: `slack channel: tenant config lookup failed: ${describeError(err)}` };
    }
    if (!cfg || !cfg.channelId || !cfg.oauthSecretKid) {
      return { status: 'failed', error: 'slack channel: tenant has no slack config' };
    }

    let token: string;
    try {
      token = await this.secrets.getSecret(cfg.oauthSecretKid);
    } catch (err) {
      return { status: 'failed', error: `slack channel: token lookup failed: ${describeError(err)}` };
    }

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
          channel: cfg.channelId,
          text:    formatText(req),
        }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return { status: 'failed', error: `slack channel: fetch failed: ${describeError(err)}` };
    }
    clearTimeout(timer);

    if (!res.ok) {
      return { status: 'failed', error: `slack channel: HTTP ${res.status}` };
    }
    let body: SlackApiResponse;
    try {
      body = await res.json() as SlackApiResponse;
    } catch (err) {
      return { status: 'failed', error: `slack channel: malformed JSON response: ${describeError(err)}` };
    }
    if (!body.ok) {
      return { status: 'failed', error: `slack channel: api error: ${body.error ?? 'unknown'}` };
    }
    return { status: 'delivered', dispatchedAt: new Date().toISOString() };
  }

  private async loadTenantConfig(tenantId: string): Promise<TenantSlackConfig | null> {
    if (!UUID_RE.test(tenantId)) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const r = await client.query<{ config: TenantSlackConfig; enabled: boolean }>(
        `SELECT config, enabled
           FROM oweibo.tenant_notification_channel_config
          WHERE tenant_id = $1::uuid AND channel_kind = 'slack'`,
        [tenantId],
      );
      await client.query('COMMIT');
      if (r.rows.length === 0) return null;
      if (r.rows[0]!.enabled === false) return null;
      return r.rows[0]!.config ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function formatText(req: NotificationDispatchRequest): string {
  if (!req.linkPath) return `*${req.title}*\n${req.body}`;
  return `*${req.title}*\n${req.body}\n<${req.linkPath}>`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
