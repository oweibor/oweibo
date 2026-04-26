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
export declare class ChannelCredentialVault {
    private readonly secrets;
    private readonly redis;
    private readonly cache;
    constructor(secrets: ISecretsManager, redis: Redis);
    private cacheKey;
    /**
     * Load and cache credentials. Called once per (tenantId, platform) at registration.
     * Validates tenantId format to prevent Vault path traversal.
     */
    load(tenantId: string, platform: Platform): Promise<TenantChannelCredential>;
    /**
     * Write token hash to Redis and confirm no other tenant owns this token.
     * Throws DuplicateBotTokenError if the token is already bound to a different tenantId.
     */
    registerCredential(cred: TenantChannelCredential): Promise<void>;
    /** Evict credential and deregister token hash from Redis on tenant deregistration. */
    evict(tenantId: string, platform: Platform): Promise<void>;
}
export declare class CredentialNotFoundError extends Error {
    constructor(tenantId: string, platform: Platform);
}
export declare class DuplicateBotTokenError extends Error {
    constructor(platform: Platform, attemptedTenant: string, existingTenant: string);
}
//# sourceMappingURL=ChannelCredentialVault.d.ts.map