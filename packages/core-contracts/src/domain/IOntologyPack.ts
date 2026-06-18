/**
 * D.1 (domain-depth): per-domain ontology pack contract.
 *
 * An ontology pack is the platform-curated vocabulary for a domain:
 *   - glossary       — term → definition (with aliases, examples)
 *   - named entities — institutions, regulators, standards
 *   - terminology    — preferred vs deprecated phrasing rules
 *   - disambiguations — sense resolution for ambiguous acronyms
 *
 * At bootstrap, `InstallOntologyPackStep` materializes the pack as
 * `domain-fact` and `tool-heuristic` memories in the tenant's LTM with
 * tags `domain:<slug>:ontology` and importance 0.85. Direct programmatic
 * access (e.g., a content inspector that needs deterministic term
 * resolution without LLM mediation) goes through `IOntologyPackRegistry`.
 */
import type { DomainSlug } from './DomainSlug.js';

export interface OntologyGlossaryEntry {
  /** Canonical surface form (often an acronym). */
  readonly term: string;
  readonly definition: string;
  readonly aliases: readonly string[];
  /** Free-form category tag — e.g. 'trading', 'risk', 'clinical', 'devops'. */
  readonly category: string;
  readonly examples?: readonly string[];
  /** Optional jurisdiction filter — recall biases to matching tenant region. */
  readonly jurisdictions?: readonly string[];
}

export type NamedEntityType =
  | 'regulator'
  | 'institution'
  | 'standard'
  | 'product'
  | 'protocol'
  | 'framework';

export interface NamedEntity {
  readonly canonicalName: string;
  readonly entityType: NamedEntityType;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly jurisdictions?: readonly string[];
  readonly externalRefs?: readonly { readonly kind: string; readonly url: string }[];
}

export type TerminologyEnforcement = 'suggest' | 'warn' | 'block';

export interface TerminologyRule {
  readonly preferred: string;
  readonly deprecated: readonly string[];
  /** One-sentence justification; surfaced in the agent's heuristic memory. */
  readonly reason: string;
  /** `block` rules feed into the D.3 compliance rule pack (artifact_time). */
  readonly enforcement: TerminologyEnforcement;
}

export interface DisambiguationSense {
  readonly meaning: string;
  /** Words/phrases whose presence biases interpretation toward this sense. */
  readonly contextTriggers: readonly string[];
  readonly weight: number;
}

export interface DisambiguationRule {
  readonly ambiguousTerm: string;
  readonly senses: readonly DisambiguationSense[];
  /** Sense to return when no context trigger matches; undefined ⇒ no default. */
  readonly defaultSense?: string;
}

export interface OntologyPackMetadata {
  /** SME name + date in free-form (audit-traceable). */
  readonly authoredBy: string;
  readonly reviewedBy: readonly string[];
  readonly authoredAt: string;
  /** D.7 currency hook — when this pack should be re-validated. */
  readonly nextReviewDue: string;
  /** Citations to the upstream sources the pack content is grounded in. */
  readonly sourceRefs: readonly string[];
}

export interface OntologyPack {
  readonly domainSlug: DomainSlug;
  readonly packVersion: string;
  /** Must match the `registryVersion` on the matching `DomainCatalogEntry`. */
  readonly registryVersion: string;
  readonly glossary: readonly OntologyGlossaryEntry[];
  readonly namedEntities: readonly NamedEntity[];
  readonly terminology: readonly TerminologyRule[];
  readonly disambiguations: readonly DisambiguationRule[];
  readonly metadata: OntologyPackMetadata;
}

/**
 * Result of a deterministic disambiguation query. Returned by
 * `IOntologyPackRegistry.getDisambiguation` when the registry can pick a
 * sense given context tokens; the registry never makes up senses, only
 * scores those declared in the pack.
 */
export interface DisambiguationResult {
  readonly term: string;
  readonly sense: string;
  /** Sum of triggered sense weights; 0 when only `defaultSense` matched. */
  readonly score: number;
  readonly usedDefault: boolean;
}

export interface IOntologyPackRegistry {
  /** Pack for the given domain, or undefined when no pack is bundled. */
  get(slug: DomainSlug): OntologyPack | undefined;

  /** Every bundled pack, in `domainSlug` order. */
  list(): readonly OntologyPack[];

  /**
   * Deterministic disambiguation. Given an ambiguous term and a list of
   * surrounding tokens, returns the highest-scoring sense whose context
   * triggers match. Falls back to the pack's `defaultSense` when no
   * trigger matches; returns `undefined` if neither a triggered sense
   * nor a default exists.
   *
   * Context tokens are matched against `contextTriggers` via
   * case-insensitive substring match — substring (not whole-word) so
   * stemming ("priced" matches "price") is handled coarsely without a
   * tokenizer dependency.
   */
  getDisambiguation(
    slug: DomainSlug,
    term: string,
    contextTokens: readonly string[],
  ): DisambiguationResult | undefined;

  /** Look up a glossary entry by term (case-insensitive). */
  findGlossaryTerm(slug: DomainSlug, term: string): OntologyGlossaryEntry | undefined;
}
