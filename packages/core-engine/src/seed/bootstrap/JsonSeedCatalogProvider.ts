/**
 * F.5.9 (ttv-finals): JsonSeedCatalogProvider adapter.
 *
 * Bridges PlatformSeedCatalog (catalog JSON loader in core-engine) to
 * the bootstrap-worker's ISeedCatalogProvider shape. The worker calls
 * forTenant() and gets back the array of SeedMemoryRequest the
 * HttpMemoryWriter will POST in batches.
 *
 * Defers to the catalog's existing template / industry / region filter
 * logic — this adapter just renames fields where the names differ and
 * drops catalog-internal fields the writer doesn't need.
 */
import type {
  PlatformSeedCatalog,
  PlatformSeedMemory,
  CatalogFilter,
} from '../PlatformSeedCatalog.js';

export interface SeedMemoryRequest {
  readonly seedId: string;
  readonly catalogVersion: string;
  readonly kind: string;
  readonly summary: string;
  readonly body?: string;
  readonly importance: number;
  readonly tags: readonly string[];
}

export class JsonSeedCatalogProvider {
  constructor(private readonly catalog: PlatformSeedCatalog) {}

  /** Pull catalog entries that match the tenant's template/industry/region, mapped to the writer's request shape. */
  forTenant(filter: { templateSlug: string; industry?: string; homeRegion?: string }): SeedMemoryRequest[] {
    const internal: CatalogFilter = {
      templateSlug: filter.templateSlug,
      ...(filter.industry ? { industry: filter.industry } : {}),
      ...(filter.homeRegion ? { homeRegion: filter.homeRegion } : {}),
    };
    return this.catalog.forTenant(internal).map(toRequest);
  }
}

function toRequest(e: PlatformSeedMemory): SeedMemoryRequest {
  const out: { -readonly [K in keyof SeedMemoryRequest]?: SeedMemoryRequest[K] } = {
    seedId: e.seedId,
    catalogVersion: e.catalogVersion,
    kind: e.kind,
    summary: e.summary,
    importance: e.importance,
    tags: e.tags,
  };
  if (e.body !== undefined) out.body = e.body;
  return out as SeedMemoryRequest;
}
