/**
 * D.0 (domain-depth): The domain registry contract.
 *
 * Every consumer of the domain taxonomy — `DomainClassifier`, tenant
 * templates, future D.1+ packs — reads from an `IDomainRegistry` instead
 * of an inline string-literal list. This keeps the catalog in one place
 * and prevents "fintech means different things in different code paths"
 * drift.
 *
 * Implementations:
 *   - `DomainRegistry` (core-engine): bundled JSON catalog, in-process
 *     cache; the default for production.
 *   - In-memory test stubs: tests construct fixtures and pass them
 *     directly to consumers.
 *
 * The registry is *read-only* from the contract surface — mutations
 * (registry version bumps, new domains, deprecation) flow through the
 * `oweibo.domain_catalog` migration path, not through this interface.
 */
import type { DomainCatalogEntry, DomainMaturity, DomainSlug } from './DomainSlug.js';
export interface IDomainRegistry {
    /** Look up a domain by slug. Returns undefined when the slug is unknown. */
    get(slug: DomainSlug): DomainCatalogEntry | undefined;
    /**
     * Look up a domain or throw. Use in code paths that should never accept
     * an unknown slug (e.g., bootstrap step resolving the tenant's bound
     * domain — an unknown slug means the binding is inconsistent with the
     * catalog and must surface, not be silently ignored).
     */
    require(slug: DomainSlug): DomainCatalogEntry;
    /** True iff the slug exists in the catalog. */
    has(slug: DomainSlug): boolean;
    /** All catalog entries, ordered by slug ascending. */
    list(): readonly DomainCatalogEntry[];
    /** Filter to entries at one of the supplied maturity tiers. */
    listByMaturity(...maturities: readonly DomainMaturity[]): readonly DomainCatalogEntry[];
}
//# sourceMappingURL=IDomainRegistry.d.ts.map