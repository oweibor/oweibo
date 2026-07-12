/**
 * T.2.f: ConnectorRegistry — in-memory catalog of platform-curated connectors.
 *
 * Loads `*.connector.json` files from a directory at startup, validates them,
 * exposes lookup + recommendation methods. The DB stores per-tenant instances
 * (oweibo.tenant_connectors); the catalog itself is code-shipped.
 *
 * Recommendation semantics: `recommend(templateSlug)` returns every catalog
 * entry whose `recommendedFor` array contains either the slug or `'*'`. The
 * SeedConnectorsStep writes those ids into tenant_bootstrap_steps.result so
 * the admin UI can render the recommendation list at onboarding time.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import type { ConnectorCatalogEntry, ConnectorCapability } from '@oweibo/core-contracts';

export class ConnectorRegistry {
  private constructor(private readonly entries: readonly ConnectorCatalogEntry[]) {}

  static async loadFromDirectory(dir: string): Promise<ConnectorRegistry> {
    const files = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [] as string[];
      throw err;
    });
    const all: ConnectorCatalogEntry[] = [];
    for (const f of files) {
      if (!f.endsWith('.connector.json')) continue;
      const raw = await fs.readFile(path.join(dir, f), 'utf-8');
      const parsed = JSON.parse(raw);
      validateEntry(parsed, f);
      all.push(coerceDefaults(parsed as ConnectorCatalogEntry));
    }
    assertConnectorIdsUnique(all);
    return new ConnectorRegistry(all);
  }

  static fromEntries(entries: readonly ConnectorCatalogEntry[]): ConnectorRegistry {
    assertConnectorIdsUnique(entries);
    return new ConnectorRegistry(entries.map(coerceDefaults));
  }

  static defaultDirectory(): string {
    return path.join(__dirname, '..', 'seed', 'connectors');
  }

  /** Look up a single catalog entry by id. Returns null if not found. */
  get(connectorId: string): ConnectorCatalogEntry | null {
    return this.entries.find((e) => e.connectorId === connectorId) ?? null;
  }

  /** Look up a specific capability across the catalog. */
  getCapability(connectorId: string, capabilityId: string): ConnectorCapability | null {
    const entry = this.get(connectorId);
    if (!entry) return null;
    return entry.capabilities.find((c) => c.capabilityId === capabilityId) ?? null;
  }

  /**
   * Recommendation for a tenant: entries whose recommendedFor includes the
   * tenant's templateSlug or `'*'`. Order is the order entries were loaded,
   * which is filesystem-alphabetic from the catalog directory.
   *
   * F.5 review: optional industry filter. When supplied AND the catalog
   * entry has a non-empty `applicableIndustries` array, the connector
   * is included only if the tenant's industry is in that list. Catalog
   * entries with no `applicableIndustries` field (or `[]`) are
   * industry-agnostic — they pass the filter unconditionally,
   * preserving byte-identical-to-today behavior for the existing
   * catalog files which don't yet declare industries.
   */
  recommend(templateSlug: string, industry?: string): ConnectorCatalogEntry[] {
    return this.entries.filter((e) => {
      const templateMatch =
        e.recommendedFor.includes('*') || e.recommendedFor.includes(templateSlug);
      if (!templateMatch) return false;
      const industries = e.applicableIndustries;
      if (industries && industries.length > 0) {
        if (!industry) return false;
        if (!industries.includes(industry)) return false;
      }
      return true;
    });
  }

  /**
   * D.4: domain-aware recommendation. Returns entries that are EITHER
   * recommended for the supplied template slug (existing semantics) OR
   * certified for one of the supplied domain slugs. The two paths are
   * unioned, not intersected, so a connector marked `recommendedFor:
   * ['*']` always appears even before it is domain-certified.
   *
   * Additionally filters by `minTier` when supplied: only connectors at
   * or above the minimum certification tier are returned. Useful for
   * enterprise tenants that want to constrain installable connectors
   * to the `verified` or `enterprise` tiers.
   */
  recommendForDomain(input: {
    readonly templateSlug: string;
    readonly domainSlugs: readonly string[];
    readonly minTier?: 'experimental' | 'community' | 'verified' | 'enterprise';
  }): ConnectorCatalogEntry[] {
    const tierOrder = { experimental: 0, community: 1, verified: 2, enterprise: 3 };
    const minRank = input.minTier ? tierOrder[input.minTier] : 0;
    return this.entries.filter((e) => {
      const cert = (e.certification ?? 'experimental') as keyof typeof tierOrder;
      if (tierOrder[cert] < minRank) return false;
      const templateMatch =
        e.recommendedFor.includes('*') || e.recommendedFor.includes(input.templateSlug);
      const certified = e.certifiedFor ?? [];
      const domainMatch = input.domainSlugs.some((d) => certified.includes(d));
      return templateMatch || domainMatch;
    });
  }

  /** All loaded catalog entries. */
  all(): readonly ConnectorCatalogEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function validateEntry(e: unknown, source: string): asserts e is ConnectorCatalogEntry {
  if (!e || typeof e !== 'object') {
    throw new Error(`ConnectorRegistry: ${source} is not an object`);
  }
  const o = e as Record<string, unknown>;
  for (const k of ['connectorId', 'displayName', 'category', 'description', 'catalogVersion'] as const) {
    if (typeof o[k] !== 'string' || o[k] === '') {
      throw new Error(`ConnectorRegistry: ${source} missing required string field ${k}`);
    }
  }
  if (!o.credentialSchema || typeof o.credentialSchema !== 'object') {
    throw new Error(`ConnectorRegistry: ${source} missing credentialSchema`);
  }
  if (!Array.isArray(o.capabilities)) {
    throw new Error(`ConnectorRegistry: ${source} has no capabilities array`);
  }
  // K.2 amendment (ADR-012 §3.2 / arch §9.5): a source-adapter-only entry
  // (the identity-only IdP connector is the canonical case) legally has
  // zero capabilities — but then it MUST claim at least one supports{}
  // flag, or the entry has no surface at all.
  if (o.capabilities.length === 0) {
    const supports = (o.supports ?? {}) as Record<string, unknown>;
    const claimed = Object.values(supports).some((v) => v === true);
    if (!claimed) {
      throw new Error(
        `ConnectorRegistry: ${source} has neither capabilities nor supports{} claims — a connector must have SOME surface`,
      );
    }
  }
  for (const cap of o.capabilities) {
    const c = cap as Record<string, unknown>;
    for (const k of ['capabilityId', 'summary', 'actionClass'] as const) {
      if (typeof c[k] !== 'string' || c[k] === '') {
        throw new Error(`ConnectorRegistry: ${source} capability missing ${k}`);
      }
    }
  }
  if (!Array.isArray(o.recommendedFor)) {
    throw new Error(`ConnectorRegistry: ${source} missing recommendedFor`);
  }
}

function assertConnectorIdsUnique(entries: readonly ConnectorCatalogEntry[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.connectorId)) {
      throw new Error(`ConnectorRegistry: duplicate connectorId ${e.connectorId}`);
    }
    seen.add(e.connectorId);
  }
}

/**
 * D.4: coerce pre-D.4 catalog entries to the canonical shape. A missing
 * `certification` field is treated as 'experimental'; missing
 * `certifiedFor` becomes []. The result is the same entry plus those
 * defaults so downstream code can rely on the fields being present.
 */
function coerceDefaults(e: ConnectorCatalogEntry): ConnectorCatalogEntry {
  if (e.certification !== undefined && e.certifiedFor !== undefined) return e;
  return {
    ...e,
    certification: e.certification ?? 'experimental',
    certifiedFor: e.certifiedFor ?? [],
  };
}
