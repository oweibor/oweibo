/**
 * QdrantVectorSearchAdapter — wraps GeneralRepoIndexer to satisfy IVectorSearch.
 *
 * The one permitted doc-generator → general-coding edge (§4.4.2, v10.5).
 * GeneralRepoIndexer.search() returns a formatted string; this adapter parses
 * it back into VectorSearchHit[] for use by SemanticAnnotator.
 */
import type { IVectorSearch, VectorSearchHit } from '@oweibo/core-contracts';
import type { GeneralRepoIndexer } from '../../general-coding/intelligence/GeneralRepoIndexer.js';
export declare class QdrantVectorSearchAdapter implements IVectorSearch {
    private readonly indexer;
    private readonly collectionName;
    constructor(indexer: GeneralRepoIndexer, collectionName: string);
    search(query: string, topK: number): Promise<readonly VectorSearchHit[]>;
}
//# sourceMappingURL=QdrantVectorSearchAdapter.d.ts.map