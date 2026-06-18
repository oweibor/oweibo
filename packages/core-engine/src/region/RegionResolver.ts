/**
 * T.8: RegionResolver — canonical normalisation for tenant home_region.
 *
 * The DB stores `home_region` as a concrete cloud-region string like
 * `us-east-1` or `eu-central-1`. Cross-tenant catalogs (priors, lessons,
 * seeds) often need to match at the coarser geographic level — an EU
 * tenant should match a seed tagged `eu-*` regardless of whether the
 * tenant lives in `eu-central-1` or `eu-west-2`.
 *
 * This resolver is pure / synchronous: it converts a concrete region
 * string into the set of glob patterns it satisfies. Callers use it to
 * filter pre-aggregated rows or seed entries by membership.
 *
 * The glob set is intentionally small and human-readable — three buckets
 * (us/eu/ap) plus the universal `*`. A new physical region added later
 * (e.g. `me-central-1`) maps to its own glob without touching consumers
 * — they just see an extra membership entry.
 *
 * `*` is always a member of the membership set: every tenant matches
 * region-neutral content unless explicitly opted out.
 */

const REGION_GLOBS: ReadonlyArray<{ prefix: string; glob: string }> = [
  { prefix: 'us-',         glob: 'us-*' },
  { prefix: 'eu-',         glob: 'eu-*' },
  { prefix: 'ap-',         glob: 'ap-*' },
  { prefix: 'ca-',         glob: 'ca-*' },
  { prefix: 'sa-',         glob: 'sa-*' },
  { prefix: 'af-',         glob: 'af-*' },
  { prefix: 'me-',         glob: 'me-*' },
];

export const REGION_NEUTRAL = '*';

export class RegionResolver {
  /**
   * Normalise an arbitrary home_region string to its canonical lowercase form.
   * Unknown strings pass through (so we don't silently mis-categorise a new
   * region added to AWS / GCP later); empty / nullish becomes the neutral '*'.
   */
  static canonical(homeRegion: string | null | undefined): string {
    if (!homeRegion) return REGION_NEUTRAL;
    const trimmed = String(homeRegion).trim().toLowerCase();
    return trimmed.length === 0 ? REGION_NEUTRAL : trimmed;
  }

  /**
   * The set of glob patterns the given home_region satisfies. Always
   * includes the neutral '*'. Used by the seed catalog and lesson recall
   * to decide whether an entry tagged e.g. `eu-*` applies to this tenant.
   */
  static membership(homeRegion: string | null | undefined): readonly string[] {
    const canonical = this.canonical(homeRegion);
    if (canonical === REGION_NEUTRAL) return [REGION_NEUTRAL];

    const out = new Set<string>([REGION_NEUTRAL, canonical]);
    for (const { prefix, glob } of REGION_GLOBS) {
      if (canonical.startsWith(prefix)) out.add(glob);
    }
    return Array.from(out);
  }

  /**
   * Does the tenant's home_region satisfy a catalog entry's `applicableRegions`?
   * Empty / undefined applicableRegions means region-agnostic — always matches.
   */
  static appliesTo(
    homeRegion: string | null | undefined,
    applicableRegions: readonly string[] | undefined,
  ): boolean {
    if (!applicableRegions || applicableRegions.length === 0) return true;
    const tenantSet = new Set(this.membership(homeRegion));
    for (const r of applicableRegions) {
      if (r === REGION_NEUTRAL) return true;
      if (tenantSet.has(r)) return true;
    }
    return false;
  }
}
