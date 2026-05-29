/**
 * F.1.6 — PgWebhookConfigResolver.
 *
 * Loads per-tenant webhook destinations from
 * `oweibo.tenant_webhook_configs` (created by migration
 * 20260605_000053_finals_infrastructure.sql) and resolves the HMAC
 * secret indirectly through SecretsManager — the DB stores only a key-id
 * pointer (`hmac_secret_kid`), not the secret itself.
 *
 * Two consumers:
 *   - GenericWebhookRollbackAdapter (kind='rollback')
 *   - WebhookChannel (kind='notification')                — F.1.3
 *
 * Caching
 *   60 s in-process TTL keyed by (tenantId, kind). The TTL is the worst-
 *   case window in which an operator change in admin-web reaches a running
 *   pod; force-refresh via invalidate() on writes from the admin route layer.
 *
 * Tenant scoping
 *   Reads run inside a transaction with SET LOCAL app.tenant_id, mirroring
 *   the InAppChannel pattern. The tenant_isolation RLS policy guarantees
 *   no cross-tenant rows leak even with platform_admin disabled.
 *
 * Multiple rows per tenant + kind
 *   Resolver picks the most-recently-updated enabled row (per the
 *   idx_tenant_webhook_configs_lookup index). Operators that want multi-
 *   destination fan-out wire a MultiWebhookChannel separately.
 */
import type { Pool } from 'pg';
import type { SecretsManager } from '../secrets/SecretsManager.js';

export type WebhookKind = 'rollback' | 'notification';

export interface ResolvedWebhookConfig {
  /** The destination URL. */
  readonly url: string;
  /** Plaintext HMAC secret, or null when no HMAC is configured. */
  readonly hmacSecret: string | null;
}

export interface IWebhookConfigResolver {
  resolve(tenantId: string, kind: WebhookKind): Promise<ResolvedWebhookConfig | null>;
  /** Drop cached entry for (tenantId, kind). Wire from the admin route layer. */
  invalidate(tenantId: string, kind: WebhookKind): void;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

export interface PgWebhookConfigResolverOptions {
  /** TTL in ms. Defaults to 60 000. */
  cacheTtlMs?: number;
  /** Override clock; tests pin time. */
  now?: () => number;
}

interface CacheEntry {
  config: ResolvedWebhookConfig | null;
  ts: number;
}

export class PgWebhookConfigResolver implements IWebhookConfigResolver {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly pool: Pool,
    private readonly secrets: SecretsManager,
    opts: PgWebhookConfigResolverOptions = {},
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async resolve(tenantId: string, kind: WebhookKind): Promise<ResolvedWebhookConfig | null> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error(`PgWebhookConfigResolver: invalid tenantId ${tenantId}`);
    }
    const cacheK = `${tenantId}:${kind}`;
    const hit = this.cache.get(cacheK);
    if (hit && this.now() - hit.ts < this.cacheTtlMs) {
      return hit.config;
    }

    const row = await this.loadRow(tenantId, kind);
    let config: ResolvedWebhookConfig | null;
    if (!row) {
      config = null;
    } else {
      const hmacSecret = row.hmac_secret_kid
        ? await this.secrets.getSecret(row.hmac_secret_kid)
        : null;
      config = { url: row.url, hmacSecret };
    }
    this.cache.set(cacheK, { config, ts: this.now() });
    return config;
  }

  invalidate(tenantId: string, kind: WebhookKind): void {
    this.cache.delete(`${tenantId}:${kind}`);
  }

  private async loadRow(
    tenantId: string,
    kind: WebhookKind,
  ): Promise<{ url: string; hmac_secret_kid: string | null } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      const r = await client.query<{ url: string; hmac_secret_kid: string | null }>(
        `SELECT url, hmac_secret_kid
           FROM oweibo.tenant_webhook_configs
          WHERE tenant_id = $1::uuid
            AND kind      = $2
            AND enabled   = TRUE
          ORDER BY updated_at DESC
          LIMIT 1`,
        [tenantId, kind],
      );
      await client.query('COMMIT');
      return r.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
