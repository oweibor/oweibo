/**
 * K.5 — ChunkEmbeddingIndexer: the post-commit bridge from the sole-writer
 * IndexingService to the vector store. It runs AFTER indexDocument commits
 * (embedding is slow and hits an external service — it must never sit inside
 * the Postgres sole-writer transaction), and it re-embeds ONLY the chunks the
 * §3.5 chunk-diff reported changed — a partial update of one field re-embeds
 * one chunk, not the whole document (arch §14).
 *
 * Vectors are a DERIVED index, eventually consistent with the committed
 * chunks. INV-1's "vector" is the RevisionVector (already written in-txn), not
 * this embedding — so a lagging embedding is a freshness question, never a
 * correctness/consistency violation.
 *
 * Gated by Indexing Scope (IndexingScopePolicy): a metadata-only tenant skips
 * embedding entirely.
 */

import type { KnowledgeVectorStore, ChunkToEmbed } from './KnowledgeVectorStore.js';
import { KnowledgeVectorStore as KVS } from './KnowledgeVectorStore.js';
import { shouldEmbed, type IndexingScope } from './IndexingScopePolicy.js';
import type { ChangedChunk } from '../indexing/IndexingService.js';

export interface ApplyDiffInput {
  readonly tenantId: string;
  readonly knowledgeObjectId: string;
  readonly documentId: string;
  readonly source: string;
  readonly sourceRevision: number;
  /** Chunk-diff toUpsert set — re-embedded. */
  readonly changedChunks: readonly ChangedChunk[];
  /** Chunk-diff toDelete set — their vectors are dropped. */
  readonly deletedChunks?: readonly Omit<ChangedChunk, 'content'>[];
  /** Tenant indexing scope; embedding is skipped unless full_content. */
  readonly scope?: IndexingScope;
}

export interface ApplyDiffResult {
  readonly embedded: number;
  readonly deleted: number;
  readonly skipped: boolean; // true when the tenant's scope is metadata-only
}

export class ChunkEmbeddingIndexer {
  constructor(private readonly store: KnowledgeVectorStore) {}

  /** Apply a chunk-diff to the vector store. Idempotent (deterministic point ids). */
  async applyDiff(input: ApplyDiffInput): Promise<ApplyDiffResult> {
    if (!shouldEmbed(input.scope)) {
      return { embedded: 0, deleted: 0, skipped: true };
    }

    const toEmbed: ChunkToEmbed[] = input.changedChunks.map((ch) => ({
      knowledgeObjectId: input.knowledgeObjectId,
      documentId: input.documentId,
      source: input.source,
      fieldName: ch.fieldName,
      spanStart: ch.spanStart,
      spanEnd: ch.spanEnd,
      sourceRevision: input.sourceRevision,
      freshnessClass: ch.freshnessClass,
      content: ch.content,
    }));

    const deletePointIds = (input.deletedChunks ?? []).map((ch) =>
      KVS.pointId(input.tenantId, input.knowledgeObjectId, ch.fieldName, ch.spanStart, ch.spanEnd),
    );

    const embedded = await this.store.upsertChunks(input.tenantId, toEmbed);
    await this.store.deletePoints(deletePointIds);
    return { embedded, deleted: deletePointIds.length, skipped: false };
  }

  /** Purge/erasure: drop every vector for the object (mirrors the tombstone chunk delete). */
  async purgeObject(tenantId: string, knowledgeObjectId: string): Promise<void> {
    await this.store.deleteObject(tenantId, knowledgeObjectId);
  }
}
