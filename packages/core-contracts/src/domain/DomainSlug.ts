/**
 * D.0 (domain-depth): Canonical domain identifiers.
 *
 * `DomainSlug` is intentionally a free-form string at the type level, not a
 * string-literal union. The authoritative list of valid slugs lives in the
 * `oweibo.domain_catalog` table and the `IDomainRegistry` runtime catalog —
 * a tighter union here would mean a code change every time the platform team
 * adds or deprecates a domain. Validation happens at runtime via
 * `IDomainRegistry.has(slug)`.
 *
 * Slugs are stable identifiers (renaming is a migration, not a refactor).
 * Conventions:
 *   - lowercase ASCII letters, digits, and hyphens
 *   - no whitespace
 *   - dotted sub-domains permitted for evolution (e.g. 'fintech.consumer'
 *     vs 'fintech.b2b') without proliferating top-level slugs
 */
export type DomainSlug = string;

/** Maturity tier a domain has reached in the platform catalog. */
export type DomainMaturity =
  | 'experimental'
  | 'beta'
  | 'general_availability'
  | 'deprecated';

/** Top-level domain grouping. */
export type DomainCategory =
  | 'regulated'      // fintech, healthcare, legal
  | 'professional'   // ecommerce, manufacturing, education
  | 'technical'      // ml-research, devops
  | 'creative';      // gaming, media

/**
 * D.8 saturation targets per domain. Empty {} (the migration default) makes
 * the composite depth score 0 across all components — the platform team is
 * expected to populate this once a domain has measurable expectations.
 *
 * All values are integers >= 0; the contract intentionally allows unknown
 * keys so the D.8 score formula can evolve without contract churn.
 */
export interface DomainDepthTargets {
  readonly ontologyEntries?: number;
  readonly rubricCount?: number;
  readonly ruleCount?: number;
  readonly verifiedConnectors?: number;
  readonly credentialedSmes?: number;
  readonly [key: string]: number | undefined;
}

/**
 * The authoritative catalog entry for a single domain. Mirrors the columns
 * of `oweibo.domain_catalog` (D.0 migration). Adding a field here requires
 * a migration; removing one is a breaking change to the contract.
 */
export interface DomainCatalogEntry {
  readonly slug: DomainSlug;
  readonly displayName: string;
  readonly description: string;
  readonly category: DomainCategory;
  /** Compliance frameworks typically applicable: 'PCI-DSS','SOC2','HIPAA','GDPR', etc. */
  readonly compliancePostures: readonly string[];
  /** Archetypal role titles for D.6 org-graph seeding: 'CFO','CISO','PI', etc. */
  readonly archetypeRoles: readonly string[];
  /** Pointers to connector ids (referenced loosely; not enforced at catalog load). */
  readonly typicalConnectors: readonly string[];
  /** Common domain verbs the classifier uses as positive signal at intake time. */
  readonly canonicalVerbiage: readonly string[];
  readonly registryVersion: string;
  readonly maturity: DomainMaturity;
  readonly depthTargets: DomainDepthTargets;
  /** ISO-8601 timestamps; nullable in case of in-memory entries assembled at test time. */
  readonly createdAt?: string;
  readonly updatedAt?: string;
}
