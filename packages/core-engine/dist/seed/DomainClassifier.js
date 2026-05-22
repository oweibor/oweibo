"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainClassifier = void 0;
exports.cosineSimilarity = cosineSimilarity;
const DEFAULT_THRESHOLD = 0.7;
class DomainClassifier {
    ontology;
    embedQuery;
    threshold;
    constructor(ontology, embedQuery, opts = {}) {
        this.ontology = ontology;
        this.embedQuery = embedQuery;
        this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    }
    /**
     * Classify the given intake text (concatenation of normalized interview
     * answers, primer extracts, repo language stats — caller's choice).
     * Returns 'unclassified' below threshold.
     */
    async classify(intakeText) {
        if (intakeText.trim().length === 0) {
            return unclassified();
        }
        const query = await this.embedQuery(intakeText);
        if (query.length === 0)
            return unclassified();
        let best = null;
        for (const entry of this.ontology) {
            if (entry.embedding.length !== query.length)
                continue;
            const sim = cosineSimilarity(query, entry.embedding);
            if (best === null || sim > best.sim) {
                best = { entry, sim };
            }
        }
        if (!best || best.sim < this.threshold)
            return unclassified();
        return {
            domain: best.entry.domain,
            confidence: best.sim,
            recommendedTemplate: best.entry.recommendedTemplate,
            recommendedConnectors: best.entry.recommendedConnectors,
        };
    }
}
exports.DomainClassifier = DomainClassifier;
function unclassified() {
    return {
        domain: 'unclassified',
        confidence: NaN,
        recommendedTemplate: null,
        recommendedConnectors: [],
    };
}
/** Cosine similarity, identical math to InMemoryGoalTemplateMatcher. */
function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
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
    if (na === 0 || nb === 0)
        return 0;
    return dot / Math.sqrt(na * nb);
}
//# sourceMappingURL=DomainClassifier.js.map