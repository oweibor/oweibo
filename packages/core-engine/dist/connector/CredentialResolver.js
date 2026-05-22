"use strict";
/**
 * T.2.f: CredentialResolver — Vault-backed credential fetcher with TTL cache.
 *
 * Resolves credentials for a (tenant, connector instance) pair by reading
 * the Vault path stored in oweibo.tenant_connectors.vault_path. A short TTL
 * cache absorbs the per-action lookup cost; cache invalidation goes via the
 * same Redis-NOTIFY pattern used by the tenant-binding cache.
 *
 * Fail-closed: a Vault miss returns null, which the calling code interprets
 * as 'no credential, no action' — the right posture for a security-critical
 * subsystem.
 *
 * The IVaultClient is injected so callers can wire production Vault (via
 * the NullVaultClient pattern in core-engine/infrastructure/VaultClient)
 * or supply a fake for tests.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialResolver = void 0;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;
class CredentialResolver {
    vault;
    ttlMs;
    maxEntries;
    now;
    cache = new Map();
    constructor(vault, opts = {}) {
        this.vault = vault;
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.now = opts.now ?? (() => Date.now());
    }
    /**
     * Fetch credentials for a specific (tenant, connector instance). The
     * caller is responsible for resolving vaultPath from
     * oweibo.tenant_connectors — typically by looking up the row by id and
     * passing its vault_path through.
     *
     * Fail-closed: returns null when Vault returns null. Callers must NOT
     * proceed with the action when this returns null.
     */
    async forTenantConnector(vaultPath) {
        const cacheKey = vaultPath;
        const cached = this.cache.get(cacheKey);
        const now = this.now();
        if (cached && cached.expiresAt > now) {
            // Touch LRU position on hit so eviction prefers genuinely-stale entries.
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, cached);
            return cached.credentials;
        }
        let credentials = null;
        try {
            credentials = await this.vault.read(vaultPath);
        }
        catch {
            credentials = null;
        }
        this.set(cacheKey, credentials, now);
        return credentials;
    }
    /**
     * Invalidate the cache entry for a vaultPath. Called when an operator
     * revokes a connector instance or rotates its credentials. The runtime
     * Redis-NOTIFY listener (out of scope here) calls this on every node.
     */
    invalidate(vaultPath) {
        this.cache.delete(vaultPath);
    }
    /** Drop the entire cache; reserved for tests + admin endpoints. */
    invalidateAll() {
        this.cache.clear();
    }
    set(key, credentials, now) {
        if (this.cache.size >= this.maxEntries) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined)
                this.cache.delete(oldest);
        }
        this.cache.set(key, { credentials, expiresAt: now + this.ttlMs });
    }
}
exports.CredentialResolver = CredentialResolver;
//# sourceMappingURL=CredentialResolver.js.map