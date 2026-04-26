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

export interface IVectorSearch {
  search(query: string, topK: number): Promise<readonly VectorSearchHit[]>;
}

export interface VectorSearchHit {
  readonly filePath: string;
  readonly snippet:  string;
  readonly score:    number;
}

/** Default implementation — returns no results; causes RepoMapBuilder fallback. */
export class NoopVectorSearch implements IVectorSearch {
  async search(_query: string, _topK: number): Promise<readonly VectorSearchHit[]> {
    return [];
  }
}
