"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DuplicateBotTokenError = exports.CredentialNotFoundError = exports.ChannelCredentialVault = void 0;
// packages/channel-gateway/src/ChannelCredentialVault.ts
// Per-tenant Vault reads + SHA-256 duplicate-token registry (§21.4)
const crypto_1 = require("crypto");
/**
 * Vault path layout:
 *   oweibo/tenants/{tenantId}/channels/{platform}/token   → bot token (string)
 *   oweibo/tenants/{tenantId}/channels/{platform}/extras  → JSON extra fields
 *
 * Redis key for duplicate detection:
 *   channel:tokens:{sha256(token)}  →  JSON { tenantId, platform }  (TTL 90d)
 */
class ChannelCredentialVault {
    secrets;
    redis;
    cache = new Map();
    constructor(secrets, redis) {
        this.secrets = secrets;
        this.redis = redis;
    }
    cacheKey(tenantId, platform) {
        return `${tenantId}:${platform}`;
    }
    /**
     * Load and cache credentials. Called once per (tenantId, platform) at registration.
     * Validates tenantId format to prevent Vault path traversal.
     */
    async load(tenantId, platform) {
        const key = this.cacheKey(tenantId, platform);
        const cached = this.cache.get(key);
        if (cached)
            return cached;
        if (!/^[0-9a-f-]{36}$/.test(tenantId)) {
            throw new Error(`ChannelCredentialVault: invalid tenantId format: ${tenantId}`);
        }
        const token = await this.secrets.getSecret(`oweibo/tenants/${tenantId}/channels/${platform}/token`);
        if (!token)
            throw new CredentialNotFoundError(tenantId, platform);
        let extras = {};
        try {
            const raw = await this.secrets.getSecret(`oweibo/tenants/${tenantId}/channels/${platform}/extras`);
            if (raw)
                extras = JSON.parse(raw);
        }
        catch { /* extras are optional */ }
        const cred = { tenantId, platform, botToken: token, extras };
        this.cache.set(key, cred);
        return cred;
    }
    /**
     * Write token hash to Redis and confirm no other tenant owns this token.
     * Throws DuplicateBotTokenError if the token is already bound to a different tenantId.
     */
    async registerCredential(cred) {
        const tokenHash = (0, crypto_1.createHash)('sha256').update(cred.botToken).digest('hex');
        const redisKey = `channel:tokens:${tokenHash}`;
        const existing = await this.redis.get(redisKey);
        if (existing) {
            const { tenantId: existingTenant } = JSON.parse(existing);
            if (existingTenant !== cred.tenantId) {
                throw new DuplicateBotTokenError(cred.platform, cred.tenantId, existingTenant);
            }
            return; // same tenant re-registering — idempotent
        }
        await this.redis.set(redisKey, JSON.stringify({ tenantId: cred.tenantId, platform: cred.platform }), 'EX', 60 * 60 * 24 * 90);
    }
    /** Evict credential and deregister token hash from Redis on tenant deregistration. */
    async evict(tenantId, platform) {
        const key = this.cacheKey(tenantId, platform);
        const cred = this.cache.get(key);
        if (cred) {
            const hash = (0, crypto_1.createHash)('sha256').update(cred.botToken).digest('hex');
            await this.redis.del(`channel:tokens:${hash}`);
        }
        this.cache.delete(key);
    }
}
exports.ChannelCredentialVault = ChannelCredentialVault;
class CredentialNotFoundError extends Error {
    constructor(tenantId, platform) {
        super(`No channel credential registered for tenant ${tenantId} on ${platform}. ` +
            `Add token at Vault path: oweibo/tenants/${tenantId}/channels/${platform}/token`);
        this.name = 'CredentialNotFoundError';
    }
}
exports.CredentialNotFoundError = CredentialNotFoundError;
class DuplicateBotTokenError extends Error {
    constructor(platform, attemptedTenant, existingTenant) {
        super(`DuplicateBotTokenError [${platform}]: token is already bound to tenant ` +
            `${existingTenant}. Cannot register for tenant ${attemptedTenant}. ` +
            `Each bot token must be unique to a single tenant.`);
        this.name = 'DuplicateBotTokenError';
    }
}
exports.DuplicateBotTokenError = DuplicateBotTokenError;
//# sourceMappingURL=ChannelCredentialVault.js.map