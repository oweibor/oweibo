"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryGoalTemplateMatcher = void 0;
exports.cosineSimilarity = cosineSimilarity;
const DEFAULT_THRESHOLD = 0.78;
class InMemoryGoalTemplateMatcher {
    entries;
    embedQuery;
    threshold;
    constructor(entries, embedQuery, opts = {}) {
        this.entries = entries;
        this.embedQuery = embedQuery;
        this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    }
    async match(goalDescription) {
        if (this.entries.length === 0)
            return null;
        const query = await this.embedQuery(goalDescription);
        if (query.length === 0)
            return null;
        let best = null;
        for (const entry of this.entries) {
            if (entry.triggerEmbedding.length !== query.length)
                continue;
            const sim = cosineSimilarity(query, entry.triggerEmbedding);
            if (best === null || sim > best.sim) {
                best = { entry, sim };
            }
        }
        if (!best || best.sim < this.threshold)
            return null;
        return {
            templateId: best.entry.templateId,
            catalogVersion: best.entry.catalogVersion,
            similarity: best.sim,
            subGoalSkeleton: best.entry.subGoalSkeleton,
        };
    }
}
exports.InMemoryGoalTemplateMatcher = InMemoryGoalTemplateMatcher;
/** Plain cosine similarity. Returns NaN-safe 0 when either norm is 0. */
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
//# sourceMappingURL=InMemoryGoalTemplateMatcher.js.map