/**
 * D.1 (domain-depth): bundled implementation of `IOntologyPackRegistry`.
 *
 * The default constructor loads `V1_ONTOLOGY_PACKS` — one stub pack per
 * v1 domain. Custom registries (tests, downstream domain extensions) can
 * pass an explicit `packs` array to the constructor.
 *
 * The registry is immutable after construction. Adding a pack requires a
 * new file under `ontology-packs/` plus an entry in `V1_ONTOLOGY_PACKS`.
 * Each pack's `registryVersion` is asserted to match the canonical
 * `DomainCatalogEntry` at registry-load time when a `DomainRegistry` is
 * supplied — this catches drift between the catalog and the packs.
 */
import type {
  DisambiguationResult,
  DomainSlug,
  OntologyGlossaryEntry,
  IDomainRegistry,
  IOntologyPackRegistry,
  OntologyPack,
} from '@oweibo/core-contracts';
import { fintechOntologyPack } from './ontology-packs/fintech.ontology.js';
import { healthcareOntologyPack } from './ontology-packs/healthcare.ontology.js';
import { legalOntologyPack } from './ontology-packs/legal.ontology.js';
import { mlResearchOntologyPack } from './ontology-packs/ml-research.ontology.js';
import { devopsOntologyPack } from './ontology-packs/devops.ontology.js';
import { ecommerceOntologyPack } from './ontology-packs/ecommerce.ontology.js';
import { gamingOntologyPack } from './ontology-packs/gaming.ontology.js';
import { mediaOntologyPack } from './ontology-packs/media.ontology.js';
import { manufacturingOntologyPack } from './ontology-packs/manufacturing.ontology.js';
import { educationOntologyPack } from './ontology-packs/education.ontology.js';

export const V1_ONTOLOGY_PACKS: readonly OntologyPack[] = [
  fintechOntologyPack,
  healthcareOntologyPack,
  legalOntologyPack,
  mlResearchOntologyPack,
  devopsOntologyPack,
  ecommerceOntologyPack,
  gamingOntologyPack,
  mediaOntologyPack,
  manufacturingOntologyPack,
  educationOntologyPack,
];

export interface OntologyPackRegistryOptions {
  /**
   * When supplied, every pack's `domainSlug` is validated against the
   * canonical catalog at load time and `registryVersion` must match the
   * catalog entry. Omit (or pass undefined) to skip validation — useful
   * in tests that don't want to wire a registry.
   */
  domainRegistry?: IDomainRegistry;
}

export class OntologyPackRegistry implements IOntologyPackRegistry {
  private readonly bySlug: ReadonlyMap<string, OntologyPack>;
  private readonly ordered: readonly OntologyPack[];

  constructor(
    packs: readonly OntologyPack[] = V1_ONTOLOGY_PACKS,
    opts: OntologyPackRegistryOptions = {},
  ) {
    const map = new Map<string, OntologyPack>();
    for (const pack of packs) {
      if (map.has(pack.domainSlug)) {
        throw new Error(
          `OntologyPackRegistry: duplicate pack for domain ${JSON.stringify(pack.domainSlug)}`,
        );
      }
      if (opts.domainRegistry) {
        const catalog = opts.domainRegistry.get(pack.domainSlug);
        if (!catalog) {
          throw new Error(
            `OntologyPackRegistry: pack domain ${JSON.stringify(pack.domainSlug)} is not in the canonical registry`,
          );
        }
        if (catalog.registryVersion !== pack.registryVersion) {
          throw new Error(
            `OntologyPackRegistry: pack ${pack.domainSlug} registryVersion ${pack.registryVersion} != catalog ${catalog.registryVersion}`,
          );
        }
      }
      map.set(pack.domainSlug, pack);
    }
    this.bySlug = map;
    this.ordered = [...packs].sort((a, b) => a.domainSlug.localeCompare(b.domainSlug));
  }

  get(slug: DomainSlug): OntologyPack | undefined {
    return this.bySlug.get(slug);
  }

  list(): readonly OntologyPack[] {
    return this.ordered;
  }

  getDisambiguation(
    slug: DomainSlug,
    term: string,
    contextTokens: readonly string[],
  ): DisambiguationResult | undefined {
    const pack = this.bySlug.get(slug);
    if (!pack) return undefined;
    const lowerTerm = term.toLowerCase();
    const rule = pack.disambiguations.find((r) => r.ambiguousTerm.toLowerCase() === lowerTerm);
    if (!rule) return undefined;

    const haystack = contextTokens.map((t) => t.toLowerCase()).join(' ');
    let best: { meaning: string; score: number } | undefined;
    for (const sense of rule.senses) {
      let score = 0;
      for (const trigger of sense.contextTriggers) {
        if (haystack.includes(trigger.toLowerCase())) {
          score += sense.weight;
        }
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { meaning: sense.meaning, score };
      }
    }
    if (best) {
      return { term, sense: best.meaning, score: best.score, usedDefault: false };
    }
    if (rule.defaultSense) {
      return { term, sense: rule.defaultSense, score: 0, usedDefault: true };
    }
    return undefined;
  }

  findGlossaryTerm(slug: DomainSlug, term: string): OntologyGlossaryEntry | undefined {
    const pack = this.bySlug.get(slug);
    if (!pack) return undefined;
    const needle = term.toLowerCase();
    return pack.glossary.find((g) => {
      if (g.term.toLowerCase() === needle) return true;
      return g.aliases.some((a) => a.toLowerCase() === needle);
    });
  }
}
