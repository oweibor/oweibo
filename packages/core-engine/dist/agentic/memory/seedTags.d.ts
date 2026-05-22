/**
 * T.2.a: shared predicates over platform-curated seed tags.
 *
 * Seed entries carry a `seed:<id>` tag plus a `seed:catalog:<version>` tag,
 * and may additionally carry `seed:suppressed:<reason>` when the per-tenant
 * feedback worker decides to suppress them. The three predicates below are
 * imported by MemoryDecayService, MemoryConsolidator, and MemoryWarmer so
 * the behavior is consistent across services.
 */
/** True if any tag starts with `seed:` — a platform-curated seed entry. */
export declare function isSeedTagged(tags: readonly string[] | undefined): boolean;
/** True if any tag starts with `seed:suppressed:` — exclude from recall. */
export declare function isSuppressedSeedTagged(tags: readonly string[] | undefined): boolean;
//# sourceMappingURL=seedTags.d.ts.map