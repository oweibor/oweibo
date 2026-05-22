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
 */
export type DomainSlug = 'finance' | 'healthcare' | 'ml-research' | 'devops' | 'ecommerce' | 'legal' | 'gaming' | 'media' | 'logistics' | 'education';
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
}
export declare class DomainClassifier {
    private readonly ontology;
    private readonly embedQuery;
    private readonly threshold;
    constructor(ontology: readonly DomainOntologyEntry[], embedQuery: QueryEmbedder, opts?: DomainClassifierOptions);
    /**
     * Classify the given intake text (concatenation of normalized interview
     * answers, primer extracts, repo language stats — caller's choice).
     * Returns 'unclassified' below threshold.
     */
    classify(intakeText: string): Promise<DomainClassification>;
}
/** Cosine similarity, identical math to InMemoryGoalTemplateMatcher. */
export declare function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number;
//# sourceMappingURL=DomainClassifier.d.ts.map