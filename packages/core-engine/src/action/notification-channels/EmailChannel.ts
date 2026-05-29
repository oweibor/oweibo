/**
 * F.1.3 — EmailChannel (production impl).
 *
 * Replaces the EmailChannel stub from ExternalChannelStubs.ts.
 *
 * SMTP transport config comes from `SecretsManager.getInfraCredentials('smtp')`
 * — a single platform-wide SMTP relay. Per-tenant from-address / reply-to
 * overrides come from `tenant_notification_channel_config.config` JSONB
 * (channel_kind='email'); when absent the platform defaults are used.
 *
 * Expected SMTP secret payload:
 *   {
 *     "host":         "smtp.relay.example",
 *     "port":         587,
 *     "user":         "username",
 *     "pass":         "password",
 *     "fromAddress":  "noreply@platform.oweibo.io",
 *     "secure":       false  // optional, default port-based (465 → true)
 *   }
 *
 * Expected per-tenant config:
 *   { "fromAddress"?: "<override>", "replyTo"?: "<address>" }
 *
 * Recipient address is taken from req.recipientHandle. If absent, dispatch
 * returns `failed` — the email channel cannot route without an explicit
 * address (we never derive one from the user table here; the router
 * upstream is responsible for resolving user → handle).
 *
 * The SMTP transport is created lazily on first dispatch and reused
 * thereafter. Connection failures surface as `failed` results, never as
 * thrown errors — the NotificationRouter relies on this contract to
 * continue dispatching to other channels.
 */
import type { Pool } from 'pg';
import type {
  DispatchResult,
  INotificationChannel,
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';
import type { SecretsManager } from '../../secrets/SecretsManager.js';
import type { Transporter } from 'nodemailer';
import { createTransport } from 'nodemailer';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SmtpSecret {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly fromAddress: string;
  readonly secure?: boolean;
}

interface TenantEmailConfig {
  readonly fromAddress?: string;
  readonly replyTo?: string;
}

export interface EmailChannelOptions {
  /**
   * Override for testing. Defaults to nodemailer.createTransport(...).
   * Receives the parsed SMTP secret and returns something that can
   * sendMail(opts) → { messageId, ... }.
   */
  readonly transportFactory?: (smtp: SmtpSecret) => Transporter;
}

export class EmailChannel implements INotificationChannel {
  readonly kind = 'email' as const;
  private cachedTransport: { signature: string; transport: Transporter } | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly secrets: SecretsManager,
    private readonly opts: EmailChannelOptions = {},
  ) {}

  async dispatch(req: NotificationDispatchRequest): Promise<DispatchResult> {
    if (!req.recipientHandle || !EMAIL_RE.test(req.recipientHandle)) {
      return {
        status: 'failed',
        error: 'email dispatch requires a valid recipientHandle',
      };
    }
    let smtp: SmtpSecret;
    try {
      smtp = await this.loadSmtpSecret();
    } catch (err) {
      return {
        status: 'failed',
        error: `email channel: smtp config unavailable: ${describeError(err)}`,
      };
    }

    let tenantCfg: TenantEmailConfig;
    try {
      tenantCfg = await this.loadTenantConfig(req.tenantId);
    } catch (err) {
      return {
        status: 'failed',
        error: `email channel: tenant config lookup failed: ${describeError(err)}`,
      };
    }

    const transport = this.getTransport(smtp);
    const from = tenantCfg.fromAddress ?? smtp.fromAddress;
    try {
      await transport.sendMail({
        from,
        to: req.recipientHandle,
        subject: req.title,
        text: bodyToPlainText(req),
        ...(tenantCfg.replyTo ? { replyTo: tenantCfg.replyTo } : {}),
      });
      return { status: 'delivered', dispatchedAt: new Date().toISOString() };
    } catch (err) {
      return {
        status: 'failed',
        error: `email channel: sendMail failed: ${describeError(err)}`,
      };
    }
  }

  private getTransport(smtp: SmtpSecret): Transporter {
    const sig = `${smtp.host}:${smtp.port}:${smtp.user}`;
    if (this.cachedTransport && this.cachedTransport.signature === sig) {
      return this.cachedTransport.transport;
    }
    const factory = this.opts.transportFactory ?? defaultTransportFactory;
    const transport = factory(smtp);
    this.cachedTransport = { signature: sig, transport };
    return transport;
  }

  private async loadSmtpSecret(): Promise<SmtpSecret> {
    const raw = (await this.secrets.getInfraCredentials('smtp')) as Partial<SmtpSecret> | null;
    if (!raw) throw new Error('infra/smtp not found in Vault');
    const required = ['host', 'port', 'user', 'pass', 'fromAddress'] as const;
    for (const k of required) {
      if (raw[k] === undefined || raw[k] === null || raw[k] === '') {
        throw new Error(`infra/smtp missing field ${k}`);
      }
    }
    return {
      host: String(raw.host),
      port: Number(raw.port),
      user: String(raw.user),
      pass: String(raw.pass),
      fromAddress: String(raw.fromAddress),
      ...(raw.secure !== undefined ? { secure: Boolean(raw.secure) } : {}),
    };
  }

  private async loadTenantConfig(tenantId: string): Promise<TenantEmailConfig> {
    if (!UUID_RE.test(tenantId)) return {};
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const r = await client.query<{ config: TenantEmailConfig; enabled: boolean }>(
        `SELECT config, enabled
           FROM oweibo.tenant_notification_channel_config
          WHERE tenant_id = $1::uuid AND channel_kind = 'email'`,
        [tenantId],
      );
      await client.query('COMMIT');
      if (r.rows.length === 0) return {};
      if (r.rows[0]!.enabled === false) {
        throw new Error('email channel disabled for this tenant');
      }
      return r.rows[0]!.config ?? {};
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function defaultTransportFactory(smtp: SmtpSecret): Transporter {
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure ?? smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

function bodyToPlainText(req: NotificationDispatchRequest): string {
  const parts = [req.body];
  if (req.linkPath) parts.push('', `Link: ${req.linkPath}`);
  return parts.join('\n');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
