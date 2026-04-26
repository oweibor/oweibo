"use strict";
/**
 * IVectorSearch — optional semantic retrieval for LLM context enrichment.
 *
 * The doc-generator runs fully without this. When provided, SemanticAnnotator
 * uses it to retrieve the top-K most relevant code chunks for prompt context.
 *
 * Implementations:
 *   QdrantVectorSearch — wraps GeneralRepoIndexer (core-engine/doc-generator/adapters/)
 *   NoopVectorSearch   — returns empty results; RepoMapBuilder output is used
 *                        as LLM context instead (ships here in core-contracts)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoopVectorSearch = void 0;
/** Default implementation — returns no results; causes RepoMapBuilder fallback. */
class NoopVectorSearch {
    async search(_query, _topK) {
        return [];
    }
}
exports.NoopVectorSearch = NoopVectorSearch;
//# sourceMappingURL=IVectorSearch.js.map