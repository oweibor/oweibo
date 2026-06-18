/**
 * F.1.7 — VaultCredentialResolver.
 *
 * A thin, opinionated facade over the lower-level T.2.f CredentialResolver
 * (./CredentialResolver.ts). Builds the canonical Vault path for a
 * (tenant, connector) pair, validates inputs, and returns a discriminated
 * result so the action-class gate can downgrade to require_approval when
 * credentials aren't available.
 *
 * Path convention
 * ───────────────
 *   `tenants/<tenantId>/connectors/<connectorId>`
 *
 * Result shape
 * ────────────
 *   { kind: 'credentials',           value: Readonly<Record<string, unknown>> }
 *   { kind: 'credential_unavailable', reason: 'not_configured' | 'unavailable' }
 *
 * - 'credentials' — Vault returned a non-null payload for the path.
 * - 'not_configured' — input IDs are malformed; nothing was queried.
 * - 'unavailable' — Vault returned null (not found / revoked) OR the
 *                   call failed (network, auth). The inner resolver
 *                   collapses these into null on purpose (fail-closed);
 *                   the wrapper reports the operator-visible state
 *                   without disambiguating beyond that.
 *
 * Caching is delegated to the inner CredentialResolver, which keeps a
 * 300 s default TTL (overridable via VAULT_TOKEN_TTL_S env or constructor
 * option). Cache invalidation is wired through invalidate(); a Vault
 * webhook listener (out of scope here) calls it on rotation/revocation.
 */
import {
  CredentialResolver,
  type CredentialResolverOptions,
  type IVaultClient,
} from './CredentialResolver.js';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export type CredentialLookupResult =
  | { readonly kind: 'credentials'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'credential_unavailable'; readonly reason: 'not_configured' | 'unavailable' };

export interface VaultCredentialResolverOptions extends CredentialResolverOptions {
  /** Override the inner resolver instead of constructing one. Tests primarily. */
  readonly inner?: CredentialResolver;
}

export class VaultCredentialResolver {
  private readonly inner: CredentialResolver;

  constructor(vault: IVaultClient, opts: VaultCredentialResolverOptions = {}) {
    if (opts.inner) {
      this.inner = opts.inner;
    } else {
      const innerOpts: CredentialResolverOptions = {
        ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
        ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.revocationRegistry !== undefined ? { revocationRegistry: opts.revocationRegistry } : {}),
      };
      this.inner = new CredentialResolver(vault, innerOpts);
    }
  }

  /**
   * Resolve credentials for a (tenant, connector) instance.
   *
   * Always returns a result — never throws. Callers map the
   * `credential_unavailable` arm onto require_approval / abort behaviour
   * upstream.
   */
  async resolveForConnector(tenantId: string, connectorId: string): Promise<CredentialLookupResult> {
    if (!UUID_RE.test(tenantId) || !ID_RE.test(connectorId)) {
      return { kind: 'credential_unavailable', reason: 'not_configured' };
    }
    const path = this.pathFor(tenantId, connectorId);
    const creds = await this.inner.forTenantConnector(path);
    if (!creds) {
      return { kind: 'credential_unavailable', reason: 'unavailable' };
    }
    return { kind: 'credentials', value: creds };
  }

  /** Drop the cached entry for (tenantId, connectorId). */
  invalidate(tenantId: string, connectorId: string): void {
    if (!UUID_RE.test(tenantId) || !ID_RE.test(connectorId)) return;
    this.inner.invalidate(this.pathFor(tenantId, connectorId));
  }

  /** Drop all cached entries. */
  invalidateAll(): void {
    this.inner.invalidateAll();
  }

  /** The canonical Vault path for a (tenantId, connectorId). */
  pathFor(tenantId: string, connectorId: string): string {
    return `tenants/${tenantId}/connectors/${connectorId}`;
  }
}

const DEFAULT_TTL_MS = 300_000;

/**
 * Construct a VaultCredentialResolver from env + a supplied Vault client.
 *
 * Env:
 *   VAULT_TOKEN_TTL_S — credential cache TTL in seconds (default 300).
 */
export function vaultCredentialResolverFromEnv(
  vault: IVaultClient,
  env: NodeJS.ProcessEnv = process.env,
  extra: Omit<VaultCredentialResolverOptions, 'ttlMs'> = {},
): VaultCredentialResolver {
  const ttlSeconds = parseInt(env['VAULT_TOKEN_TTL_S'] ?? '300', 10);
  const ttlMs = (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 300) * 1000;
  return new VaultCredentialResolver(vault, { ...extra, ttlMs });
}
