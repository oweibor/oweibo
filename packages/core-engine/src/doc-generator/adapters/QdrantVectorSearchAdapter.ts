/**
 * QdrantVectorSearchAdapter — wraps GeneralRepoIndexer to satisfy IVectorSearch.
 *
 * The one permitted doc-generator → general-coding edge (§4.4.2, v10.5).
 * GeneralRepoIndexer.search() returns a formatted string; this adapter parses
 * it back into VectorSearchHit[] for use by SemanticAnnotator.
 */

import type { IVectorSearch, VectorSearchHit } from '@oweibo/core-contracts';
import type { GeneralRepoIndexer } from '../../general-coding/intelligence/GeneralRepoIndexer.js';

export class QdrantVectorSearchAdapter implements IVectorSearch {
  constructor(
    private readonly indexer:         GeneralRepoIndexer,
    private readonly collectionName:  string,
  ) {}

  async search(query: string, topK: number): Promise<readonly VectorSearchHit[]> {
    const raw = await this.indexer.search(this.collectionName, query, topK);
    return parseSearchResult(raw);
  }
}

function parseSearchResult(raw: string): VectorSearchHit[] {
  if (!raw.trim()) return [];
  const hits: VectorSearchHit[] = [];
  const blocks = raw.split(/\n### /);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const newline = trimmed.indexOf('\n');
    const filePath = (newline === -1 ? trimmed : trimmed.slice(0, newline)).replace(/^### /, '').trim();
    const snippet  = newline === -1 ? '' : trimmed.slice(newline + 1).trim();
    hits.push({ filePath, snippet, score: 1.0 });
  }
  return hits;
}
