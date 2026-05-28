/**
 * D.0 (domain-depth): in-memory implementation of `IDomainRegistry`.
 *
 * The default constructor wires the bundled v1 catalog (`V1_DOMAIN_CATALOG`)
 * — appropriate for CLIs, tests, and any context where the database is not
 * the source of truth. Production wires `fromRows(pgRows)` so the table's
 * contents (which platform admins may edit between migrations) take
 * precedence.
 *
 * The registry is immutable after construction. Schema evolution (a new
 * domain, a deprecated one) happens via a migration + a new
 * `DomainRegistry` instance on the next process restart — there is
 * intentionally no `register()` runtime mutation API. Per the domain-depth
 * design principle: "Domain is a first-class structural property, not a
 * tag" (ttv-domain-depth.md §2, principle 22).
 */
import type {
  DomainCatalogEntry,
  DomainMaturity,
  DomainSlug,
  IDomainRegistry,
} from '@oweibo/core-contracts';
import { V1_DOMAIN_CATALOG } from './domain-catalog/catalog.js';

/** Shape of a row returned by `SELECT * FROM oweibo.domain_catalog`. */
export interface DomainCatalogRow {
  readonly slug: string;
  readonly display_name: string;
  readonly description: string;
  readonly category: string;
  readonly compliance_postures: readonly string[] | null;
  readonly archetype_roles: readonly string[] | null;
  readonly typical_connectors: readonly string[] | null;
  readonly canonical_verbiage: readonly string[] | null;
  readonly registry_version: string;
  readonly maturity: string;
  readonly depth_targets: Record<string, number> | null;
  readonly created_at?: Date | string | null;
  readonly updated_at?: Date | string | null;
}

const ALLOWED_CATEGORIES = new Set(['regulated', 'professional', 'technical', 'creative']);
const ALLOWED_MATURITIES: ReadonlySet<DomainMaturity> = new Set<DomainMaturity>([
  'experimental',
  'beta',
  'general_availability',
  'deprecated',
]);

export class DomainRegistry implements IDomainRegistry {
  private readonly bySlug: ReadonlyMap<string, DomainCatalogEntry>;
  private readonly ordered: readonly DomainCatalogEntry[];

  constructor(entries: readonly DomainCatalogEntry[] = V1_DOMAIN_CATALOG) {
    const map = new Map<string, DomainCatalogEntry>();
    for (const e of entries) {
      if (map.has(e.slug)) {
        throw new Error(`DomainRegistry: duplicate slug ${JSON.stringify(e.slug)}`);
      }
      if (!ALLOWED_CATEGORIES.has(e.category)) {
        throw new Error(
          `DomainRegistry: invalid category ${JSON.stringify(e.category)} for slug ${e.slug}`,
        );
      }
      if (!ALLOWED_MATURITIES.has(e.maturity)) {
        throw new Error(
          `DomainRegistry: invalid maturity ${JSON.stringify(e.maturity)} for slug ${e.slug}`,
        );
      }
      map.set(e.slug, e);
    }
    this.bySlug = map;
    this.ordered = [...entries].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Build a registry from `oweibo.domain_catalog` rows. Throws on the
   * same shape violations the constructor enforces — a malformed row in
   * production is a configuration bug worth failing loudly on.
   */
  static fromRows(rows: readonly DomainCatalogRow[]): DomainRegistry {
    return new DomainRegistry(rows.map(rowToEntry));
  }

  get(slug: DomainSlug): DomainCatalogEntry | undefined {
    return this.bySlug.get(slug);
  }

  require(slug: DomainSlug): DomainCatalogEntry {
    const e = this.bySlug.get(slug);
    if (!e) {
      throw new Error(`DomainRegistry: unknown domain slug ${JSON.stringify(slug)}`);
    }
    return e;
  }

  has(slug: DomainSlug): boolean {
    return this.bySlug.has(slug);
  }

  list(): readonly DomainCatalogEntry[] {
    return this.ordered;
  }

  listByMaturity(...maturities: readonly DomainMaturity[]): readonly DomainCatalogEntry[] {
    if (maturities.length === 0) return [];
    const want = new Set(maturities);
    return this.ordered.filter((e) => want.has(e.maturity));
  }
}

function rowToEntry(r: DomainCatalogRow): DomainCatalogEntry {
  return {
    slug: r.slug,
    displayName: r.display_name,
    description: r.description,
    category: r.category as DomainCatalogEntry['category'],
    compliancePostures: r.compliance_postures ?? [],
    archetypeRoles: r.archetype_roles ?? [],
    typicalConnectors: r.typical_connectors ?? [],
    canonicalVerbiage: r.canonical_verbiage ?? [],
    registryVersion: r.registry_version,
    maturity: r.maturity as DomainMaturity,
    depthTargets: (r.depth_targets ?? {}) as DomainCatalogEntry['depthTargets'],
    ...(r.created_at !== undefined && r.created_at !== null
      ? { createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) }
      : {}),
    ...(r.updated_at !== undefined && r.updated_at !== null
      ? { updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at) }
      : {}),
  };
}
