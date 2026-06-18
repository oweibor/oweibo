/**
 * T.2.g: DomainClassifier — cosine-match incoming intake content against a
 * pre-curated ontology of known domains. Produces (domain, confidence) with
 * a hard threshold below which we return 'unclassified'.
 *
 * The classifier is deterministic given embeddings. The only optional LLM
 * use is to *normalize* free-text interview answers into a canonical form
 * before embedding — out of scope here; the service caller is expected to
 * normalize first (or pass raw text through; the embedder doesn't care).
 *
 * Pattern matches InMemoryGoalTemplateMatcher: catalog is in-memory with
 * precomputed embeddings; cosine similarity is computed in process.
 *
 * D.0 (domain-depth) — `DomainSlug` is now an alias for the canonical
 * registry slug type (a plain string validated at runtime). An optional
 * `IDomainRegistry` constructor seam validates that every ontology entry's
 * slug exists in the canonical catalog; the default (no registry) preserves
 * pre-D.0 behavior for tests and consumers that operate on ad-hoc slugs.
 */
import type { DomainSlug as RegistryDomainSlug, IDomainRegistry } from '@oweibo/core-contracts';

/**
 * @deprecated The string-literal union was removed by D.0. Slugs are now
 * validated at runtime against `IDomainRegistry`. This alias is retained
 * so existing imports keep compiling.
 */
export type DomainSlug = RegistryDomainSlug;

export interface DomainOntologyEntry {
  readonly domain: DomainSlug;
  readonly displayName: string;
  /** Pre-computed embedding for the domain's canonical description. */
  readonly embedding: ReadonlyArray<number>;
  /** Slug of the tenant template recommended for this domain. */
  readonly recommendedTemplate: string;
  /** Connector ids to recommend at intake time. */
  readonly recommendedConnectors: readonly string[];
}

export interface DomainClassification {
  readonly domain: DomainSlug | 'unclassified';
  /** 0..1 cosine similarity to the chosen domain (NaN when unclassified). */
  readonly confidence: number;
  readonly recommendedTemplate: string | null;
  readonly recommendedConnectors: readonly string[];
}

export type QueryEmbedder = (text: string) => Promise<ReadonlyArray<number>>;

export interface DomainClassifierOptions {
  /** Minimum similarity for a match. Default 0.70 (per ttv.md §T.2.g). */
  threshold?: number;
  /**
   * D.0: optional canonical-taxonomy seam. When supplied, every ontology
   * entry's slug is validated against the registry at construction time.
   * Omit to preserve pre-D.0 behavior — ad-hoc slugs are accepted.
   */
  registry?: IDomainRegistry;
}

const DEFAULT_THRESHOLD = 0.7;

export class DomainClassifier {
  private readonly threshold: number;

  constructor(
    private readonly ontology: readonly DomainOntologyEntry[],
    private readonly embedQuery: QueryEmbedder,
    opts: DomainClassifierOptions = {},
  ) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    if (opts.registry) {
      for (const entry of ontology) {
        if (!opts.registry.has(entry.domain)) {
          throw new Error(
            `DomainClassifier: ontology entry slug ${JSON.stringify(entry.domain)} is not in the canonical domain registry`,
          );
        }
      }
    }
  }

  /**
   * Classify the given intake text (concatenation of normalized interview
   * answers, primer extracts, repo language stats — caller's choice).
   * Returns 'unclassified' below threshold.
   */
  async classify(intakeText: string): Promise<DomainClassification> {
    if (intakeText.trim().length === 0) {
      return unclassified();
    }
    const query = await this.embedQuery(intakeText);
    if (query.length === 0) return unclassified();

    let best: { entry: DomainOntologyEntry; sim: number } | null = null;
    for (const entry of this.ontology) {
      if (entry.embedding.length !== query.length) continue;
      const sim = cosineSimilarity(query, entry.embedding);
      if (best === null || sim > best.sim) {
        best = { entry, sim };
      }
    }

    if (!best || best.sim < this.threshold) return unclassified();

    return {
      domain: best.entry.domain,
      confidence: best.sim,
      recommendedTemplate: best.entry.recommendedTemplate,
      recommendedConnectors: best.entry.recommendedConnectors,
    };
  }
}

function unclassified(): DomainClassification {
  return {
    domain: 'unclassified',
    confidence: NaN,
    recommendedTemplate: null,
    recommendedConnectors: [],
  };
}

/** Cosine similarity, identical math to InMemoryGoalTemplateMatcher. */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
