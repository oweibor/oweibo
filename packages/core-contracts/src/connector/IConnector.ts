/**
 * T.2.f: connector + capability contracts.
 *
 * A Connector is a typed integration (Slack, Postgres, GitHub, …). Each
 * connector exposes one or more Capabilities — discrete actions the
 * connector can perform. Each capability declares its ActionClass so the
 * T.−1 trust ladder gates execution centrally.
 *
 * Catalog entries are platform-curated JSON files; this contract describes
 * their shape. Tenants install instances of catalog entries — a tenant may
 * have multiple instances of the same connector (e.g. postgres-prod and
 * postgres-dev) each with its own credential set in Vault.
 */

export type ConnectorCategory =
  | 'communication'
  | 'source_control'
  | 'database'
  | 'storage'
  | 'observability'
  | 'payment'
  | 'identity'
  | 'custom';

export type ShadowMode = 'mock' | 'sandbox_endpoint' | 'pre_declared_replica';

export interface ConnectorCapability {
  readonly capabilityId: string;
  readonly summary: string;
  /** Action class consumed by the T.−1 trust ladder. Keeps gating centralized. */
  readonly actionClass: string;
  /** JSONSchema for the capability's input payload. */
  readonly inputSchema: unknown;
  /** JSONSchema for the capability's output payload. */
  readonly outputSchema: unknown;
  /** Optional shadow-execution target spec; ActionTrustLadder.gate routes to it
   *  when mode === 'shadow'. */
  readonly shadowTarget?: {
    readonly mode: ShadowMode;
    readonly config?: unknown;
  };
}

/**
 * D.4 (domain-depth): certification tier a connector has reached.
 *
 *   - 'experimental' — author-asserted; no automated test bar
 *   - 'community'    — passes SDK contract tests + basic integration
 *   - 'verified'     — community + rollback adapter + platform review
 *   - 'enterprise'   — verified + per-domain certification + 90d telemetry
 *                       + named maintainer with SLA
 *
 * Pre-D.4 catalog entries that omit `certification` default to
 * `experimental` at registry-load time so existing JSON files keep
 * working.
 */
export type CertificationTier = 'experimental' | 'community' | 'verified' | 'enterprise';

export interface ConnectorCatalogEntry {
  readonly connectorId: string;
  readonly displayName: string;
  readonly category: ConnectorCategory;
  readonly description: string;
  readonly catalogVersion: string;
  /** JSONSchema for the credential payload the tenant must supply during install. */
  readonly credentialSchema: unknown;
  readonly capabilities: readonly ConnectorCapability[];
  /** Tenant templates that should auto-recommend this connector. `'*'` = any. */
  readonly recommendedFor: readonly string[];
  /**
   * D.4: certification tier reached by this catalog version. Optional in
   * the contract for backwards compatibility — the registry coerces a
   * missing value to 'experimental' at load time.
   */
  readonly certification?: CertificationTier;
  /**
   * D.4: domain slugs (D.0) this connector has been certified for. A
   * connector certified for a domain has passed that domain's
   * certification battery (D.4 SDK). When a tenant queries
   * recommendations for a domain, the registry filters connectors by
   * presence in this array. Empty `[]` means the connector is generic
   * — it is recommended for tenants without a bound domain but does
   * not appear in domain-specific recommendation lists.
   */
  readonly certifiedFor?: readonly string[];
}

/** A per-tenant installed instance, as stored in oweibo.tenant_connectors. */
export interface TenantConnectorInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly connectorId: string;
  readonly catalogVersion: string;
  readonly instanceLabel: string;
  readonly vaultPath: string;
  readonly status: 'pending' | 'active' | 'suspended' | 'revoked';
  readonly installedBy: string | null;
  readonly installedAt: string;
  readonly lastUsedAt: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}
