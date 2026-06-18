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

/**
 * Audit-fix (T.2.f): pluggable revocation registry. The resolver
 * consults this on every cache miss before serving Vault data.
 *
 * The audit's concern: pub/sub revocation only reaches subscribers
 * already running. A new CredentialResolver instance starting AFTER
 * the broadcast hydrates its cache from Vault on first miss and serves
 * the revoked credential for up to one TTL. Checking this registry on
 * every miss closes the TOCTOU window. Pub/sub remains the fast-path
 * invalidation for already-running instances.
 *
 * The default no-op implementation preserves pre-fix behavior. Wire
 * the production implementation that queries oweibo.revoked_connector_
 * credentials.
 */
export interface IRevocationRegistry {
  /** Returns true if the given Vault path has been revoked. */
  isRevoked(vaultPath: string): Promise<boolean>;
}

export interface CredentialResolverOptions {
  /** TTL in ms before a cache entry is re-fetched. Default 60s. */
  ttlMs?: number;
  /** Max cached entries before LRU eviction. Default 10 000. */
  maxEntries?: number;
  /** Override the clock for tests. */
  now?: () => number;
  /**
   * Audit-fix (T.2.f): consulted on every cache miss. When omitted
   * the resolver behaves as it did pre-fix — pub/sub-only
   * invalidation, vulnerable to the new-pod TOCTOU window.
   */
  revocationRegistry?: IRevocationRegistry;
}

interface CacheEntry {
  credentials: Readonly<Record<string, unknown>> | null;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export class CredentialResolver {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly revocationRegistry: IRevocationRegistry | undefined;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly vault: IVaultClient, opts: CredentialResolverOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? (() => Date.now());
    this.revocationRegistry = opts.revocationRegistry;
  }

  /**
   * Fetch credentials for a specific (tenant, connector instance). The
   * caller is responsible for resolving vaultPath from
   * oweibo.tenant_connectors — typically by looking up the row by id and
   * passing its vault_path through.
   *
   * Fail-closed: returns null when Vault returns null, when the path is
   * in the revocation registry (audit-fix T.2.f), or when Vault throws.
   * Callers must NOT proceed with the action when this returns null.
   */
  async forTenantConnector(vaultPath: string): Promise<Readonly<Record<string, unknown>> | null> {
    const cacheKey = vaultPath;
    const cached = this.cache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      // Touch LRU position on hit so eviction prefers genuinely-stale entries.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached.credentials;
    }

    // Audit-fix (T.2.f): on every cache miss, consult the revocation
    // registry BEFORE touching Vault. This closes the TOCTOU window
    // where a new pod (started after a revocation broadcast) would
    // otherwise hydrate the revoked credential from Vault and serve it
    // for up to one TTL until its own first invalidation arrives.
    if (this.revocationRegistry) {
      try {
        const revoked = await this.revocationRegistry.isRevoked(vaultPath);
        if (revoked) {
          // Cache the null result so we don't re-check the registry on
          // every action for the TTL window — the operator-issued
          // invalidate() call (pub/sub) will clear it sooner.
          this.set(cacheKey, null, now);
          return null;
        }
      } catch {
        // A registry blip MUST NOT serve stale credentials. Fail-closed.
        return null;
      }
    }

    let credentials: Readonly<Record<string, unknown>> | null = null;
    try {
      credentials = await this.vault.read(vaultPath);
    } catch {
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
  invalidate(vaultPath: string): void {
    this.cache.delete(vaultPath);
  }

  /** Drop the entire cache; reserved for tests + admin endpoints. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private set(key: string, credentials: Readonly<Record<string, unknown>> | null, now: number): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { credentials, expiresAt: now + this.ttlMs });
  }
}
