"use strict";
/**
 * QdrantVectorSearchAdapter — wraps GeneralRepoIndexer to satisfy IVectorSearch.
 *
 * The one permitted doc-generator → general-coding edge (§4.4.2, v10.5).
 * GeneralRepoIndexer.search() returns a formatted string; this adapter parses
 * it back into VectorSearchHit[] for use by SemanticAnnotator.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QdrantVectorSearchAdapter = void 0;
class QdrantVectorSearchAdapter {
    indexer;
    collectionName;
    constructor(indexer, collectionName) {
        this.indexer = indexer;
        this.collectionName = collectionName;
    }
    async search(query, topK) {
        const raw = await this.indexer.search(this.collectionName, query, topK);
        return parseSearchResult(raw);
    }
}
exports.QdrantVectorSearchAdapter = QdrantVectorSearchAdapter;
function parseSearchResult(raw) {
    if (!raw.trim())
        return [];
    const hits = [];
    const blocks = raw.split(/\n### /);
    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed)
            continue;
        const newline = trimmed.indexOf('\n');
        const filePath = (newline === -1 ? trimmed : trimmed.slice(0, newline)).replace(/^### /, '').trim();
        const snippet = newline === -1 ? '' : trimmed.slice(newline + 1).trim();
        hits.push({ filePath, snippet, score: 1.0 });
    }
    return hits;
}
//# sourceMappingURL=QdrantVectorSearchAdapter.js.map