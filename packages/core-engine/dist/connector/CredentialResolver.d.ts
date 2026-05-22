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
export interface IVaultClient {
    /** Read a secret at the given path. Returns null if absent. */
    read(path: string): Promise<Readonly<Record<string, unknown>> | null>;
}
export interface CredentialResolverOptions {
    /** TTL in ms before a cache entry is re-fetched. Default 60s. */
    ttlMs?: number;
    /** Max cached entries before LRU eviction. Default 10 000. */
    maxEntries?: number;
    /** Override the clock for tests. */
    now?: () => number;
}
export declare class CredentialResolver {
    private readonly vault;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly now;
    private readonly cache;
    constructor(vault: IVaultClient, opts?: CredentialResolverOptions);
    /**
     * Fetch credentials for a specific (tenant, connector instance). The
     * caller is responsible for resolving vaultPath from
     * oweibo.tenant_connectors — typically by looking up the row by id and
     * passing its vault_path through.
     *
     * Fail-closed: returns null when Vault returns null. Callers must NOT
     * proceed with the action when this returns null.
     */
    forTenantConnector(vaultPath: string): Promise<Readonly<Record<string, unknown>> | null>;
    /**
     * Invalidate the cache entry for a vaultPath. Called when an operator
     * revokes a connector instance or rotates its credentials. The runtime
     * Redis-NOTIFY listener (out of scope here) calls this on every node.
     */
    invalidate(vaultPath: string): void;
    /** Drop the entire cache; reserved for tests + admin endpoints. */
    invalidateAll(): void;
    private set;
}
//# sourceMappingURL=CredentialResolver.d.ts.map