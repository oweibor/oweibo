// packages/channel-gateway/src/ChannelCredentialVault.ts
// Per-tenant Vault reads + SHA-256 duplicate-token registry (§21.4)
import { createHash } from 'crypto';
import type { ISecretsManager } from '@oweibo/core-contracts';
import type { Platform } from '@oweibo/channel-contracts';
import type { Redis } from 'ioredis';

export interface TenantChannelCredential {
  tenantId: string;
  platform: Platform;
  botToken: string;
  /** Platform-specific extras (signingSecret, phoneNumberId, apiUrl, etc.) */
  extras: Record<string, string>;
}

/**
 * Vault path layout:
 *   oweibo/tenants/{tenantId}/channels/{platform}/token   → bot token (string)
 *   oweibo/tenants/{tenantId}/channels/{platform}/extras  → JSON extra fields
 *
 * Redis key for duplicate detection:
 *   channel:tokens:{sha256(token)}  →  JSON { tenantId, platform }  (TTL 90d)
 */
export class ChannelCredentialVault {
  private readonly cache = new Map<string, TenantChannelCredential>();

  constructor(
    private readonly secrets: ISecretsManager,
    private readonly redis: Redis,
  ) {}

  private cacheKey(tenantId: string, platform: Platform): string {
    return `${tenantId}:${platform}`;
  }

  /**
   * Load and cache credentials. Called once per (tenantId, platform) at registration.
   * Validates tenantId format to prevent Vault path traversal.
   */
  async load(tenantId: string, platform: Platform): Promise<TenantChannelCredential> {
    const key = this.cacheKey(tenantId, platform);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (!/^[0-9a-f-]{36}$/.test(tenantId)) {
      throw new Error(`ChannelCredentialVault: invalid tenantId format: ${tenantId}`);
    }

    const token = await (this.secrets as any).getSecret(
      `oweibo/tenants/${tenantId}/channels/${platform}/token`,
    );
    if (!token) throw new CredentialNotFoundError(tenantId, platform);

    let extras: Record<string, string> = {};
    try {
      const raw = await (this.secrets as any).getSecret(
        `oweibo/tenants/${tenantId}/channels/${platform}/extras`,
      );
      if (raw) extras = JSON.parse(raw) as Record<string, string>;
    } catch { /* extras are optional */ }

    const cred: TenantChannelCredential = { tenantId, platform, botToken: token, extras };
    this.cache.set(key, cred);
    return cred;
  }

  /**
   * Write token hash to Redis and confirm no other tenant owns this token.
   * Throws DuplicateBotTokenError if the token is already bound to a different tenantId.
   */
  async registerCredential(cred: TenantChannelCredential): Promise<void> {
    const tokenHash = createHash('sha256').update(cred.botToken).digest('hex');
    const redisKey = `channel:tokens:${tokenHash}`;
    const existing = await this.redis.get(redisKey);

    if (existing) {
      const { tenantId: existingTenant } = JSON.parse(existing) as { tenantId: string };
      if (existingTenant !== cred.tenantId) {
        throw new DuplicateBotTokenError(cred.platform, cred.tenantId, existingTenant);
      }
      return; // same tenant re-registering — idempotent
    }

    await this.redis.set(
      redisKey,
      JSON.stringify({ tenantId: cred.tenantId, platform: cred.platform }),
      'EX', 60 * 60 * 24 * 90, // 90 days
    );
  }

  /** Evict credential and deregister token hash from Redis on tenant deregistration. */
  async evict(tenantId: string, platform: Platform): Promise<void> {
    const key = this.cacheKey(tenantId, platform);
    const cred = this.cache.get(key);
    if (cred) {
      const hash = createHash('sha256').update(cred.botToken).digest('hex');
      await this.redis.del(`channel:tokens:${hash}`);
    }
    this.cache.delete(key);
  }
}

export class CredentialNotFoundError extends Error {
  constructor(tenantId: string, platform: Platform) {
    super(
      `No channel credential registered for tenant ${tenantId} on ${platform}. ` +
      `Add token at Vault path: oweibo/tenants/${tenantId}/channels/${platform}/token`,
    );
    this.name = 'CredentialNotFoundError';
  }
}

export class DuplicateBotTokenError extends Error {
  constructor(platform: Platform, attemptedTenant: string, existingTenant: string) {
    super(
      `DuplicateBotTokenError [${platform}]: token is already bound to tenant ` +
      `${existingTenant}. Cannot register for tenant ${attemptedTenant}. ` +
      `Each bot token must be unique to a single tenant.`,
    );
    this.name = 'DuplicateBotTokenError';
  }
}
