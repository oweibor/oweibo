/**
 * K.5 — KnowledgeVectorStore: fabric chunk embeddings in Qdrant (arch §4.5,
 * §20). One vector per chunk, payload-filtered by `tenant_id` (the current
 * isolation posture, §20) on every search — a query for tenant A can never
 * surface tenant B's vectors because the filter is unconditional, not
 * caller-supplied.
 *
 * REUSED, not forked (roadmap K.5): the injected Qdrant client and the
 * injected `Embedder` (production wires OllamaEmbedder, optionally behind
 * EmbeddingCache). This store owns only the fabric payload schema and the
 * tenant-filter discipline — distinct from the MemoryKind QdrantSemanticStore
 * (whose payload is importance/kind-shaped, not chunk-shaped).
 *
 * Point identity is deterministic per (knowledge_object_id, field_name, span)
 * so a chunk-diff re-embed (ChunkEmbeddingIndexer) UPSERTS in place rather
 * than accumulating stale duplicates.
 */

import { createHash } from 'crypto';
import type { Embedder } from '../../agentic/memory/QdrantSemanticStore.js';

// @qdrant/js-client-rest is ESM-only; same alias pattern used across the repo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClient = any;

/** The fabric chunk payload (distinct from the memory-tier payload). */
export interface ChunkVectorPayload {
  readonly tenant_id: string;
  readonly knowledge_object_id: string;
  readonly document_id: string;
  readonly source: string;
  readonly field_name: string;
  readonly span_start: number;
  readonly span_end: number;
  readonly source_revision: number;
  readonly freshness_class: string;
  readonly content: string;
}

export interface ChunkToEmbed {
  readonly knowledgeObjectId: string;
  readonly documentId: string;
  readonly source: string;
  readonly fieldName: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly sourceRevision: number;
  readonly freshnessClass: string;
  readonly content: string;
}

export interface VectorSearchHit {
  readonly knowledgeObjectId: string;
  readonly documentId: string;
  readonly fieldName: string;
  readonly score: number; // cosine in [0,1]
}

export interface KnowledgeVectorStoreConfig {
  /** Shared collection; tenant isolation is by payload filter (§20). */
  readonly collection?: string;
  /** Embedding dimension for auto-created collections (default 768, nomic). */
  readonly vectorDimension?: number;
  /** Over-fetch multiplier before the hybrid re-rank (default 3). */
  readonly overFetchMultiplier?: number;
}

const DEFAULT_COLLECTION = 'kf_knowledge_vectors';

export class KnowledgeVectorStore {
  private readonly collection: string;
  private readonly dim: number;
  private readonly overFetch: number;

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly embedder: Embedder,
    config: KnowledgeVectorStoreConfig = {},
  ) {
    this.collection = config.collection ?? DEFAULT_COLLECTION;
    this.dim = config.vectorDimension ?? 768;
    this.overFetch = config.overFetchMultiplier ?? 3;
  }

  /** Deterministic point id per chunk identity (so re-embed upserts in place). */
  static pointId(tenantId: string, knowledgeObjectId: string, fieldName: string, spanStart: number, spanEnd: number): string {
    const canon = `${tenantId}|${knowledgeObjectId}|${fieldName}|${spanStart}|${spanEnd}`;
    // UUIDv5-shaped from a sha256 — stable and collision-safe for our keyspace.
    const hex = createHash('sha256').update(canon).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  private async ensureCollection(): Promise<void> {
    try {
      await this.qdrant.getCollection(this.collection);
    } catch {
      try {
        await this.qdrant.createCollection(this.collection, {
          vectors: { size: this.dim, distance: 'Cosine' },
        });
      } catch {
        // Race: another writer created it — fine (idempotent).
      }
    }
  }

  /** Embed and upsert the given chunks (used by ChunkEmbeddingIndexer for toUpsert). */
  async upsertChunks(tenantId: string, chunks: readonly ChunkToEmbed[]): Promise<number> {
    if (chunks.length === 0) return 0;
    await this.ensureCollection();
    const points: Array<{ id: string; vector: number[]; payload: ChunkVectorPayload }> = [];
    for (const ch of chunks) {
      const vector = await this.embedder(ch.content);
      const payload: ChunkVectorPayload = {
        tenant_id: tenantId,
        knowledge_object_id: ch.knowledgeObjectId,
        document_id: ch.documentId,
        source: ch.source,
        field_name: ch.fieldName,
        span_start: ch.spanStart,
        span_end: ch.spanEnd,
        source_revision: ch.sourceRevision,
        freshness_class: ch.freshnessClass,
        content: ch.content,
      };
      points.push({
        id: KnowledgeVectorStore.pointId(tenantId, ch.knowledgeObjectId, ch.fieldName, ch.spanStart, ch.spanEnd),
        vector,
        payload,
      });
    }
    await this.qdrant.upsert(this.collection, { wait: true, points });
    return points.length;
  }

  /** Drop specific chunk vectors by point id (chunk-diff removals). */
  async deletePoints(pointIds: readonly string[]): Promise<void> {
    if (pointIds.length === 0) return;
    try {
      await this.qdrant.delete(this.collection, { wait: true, points: [...pointIds] });
    } catch {
      // Collection may not exist yet — nothing to delete.
    }
  }

  /** Drop all vectors for a knowledge object (purge / erasure). */
  async deleteObject(tenantId: string, knowledgeObjectId: string): Promise<void> {
    try {
      await this.qdrant.delete(this.collection, {
        wait: true,
        filter: {
          must: [
            { key: 'tenant_id', match: { value: tenantId } },
            { key: 'knowledge_object_id', match: { value: knowledgeObjectId } },
          ],
        },
      });
    } catch {
      // Collection may not exist yet — nothing to delete.
    }
  }

  /**
   * Semantic search within a tenant. The `tenant_id` filter is UNCONDITIONAL
   * — cross-tenant leakage is impossible by construction (§20). Returns one
   * hit per chunk; callers fold to object granularity and hybrid-rank.
   */
  async search(tenantId: string, queryText: string, limit: number): Promise<VectorSearchHit[]> {
    const vector = await this.embedder(queryText);
    let raw: Array<{ score: number; payload: Partial<ChunkVectorPayload> }>;
    try {
      raw = await this.qdrant.search(this.collection, {
        vector,
        limit: limit * this.overFetch,
        with_payload: true,
        filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
      });
    } catch {
      return []; // collection absent → no semantic candidates yet
    }
    return raw
      .filter((r) => r.payload && r.payload.knowledge_object_id !== undefined)
      .map((r) => ({
        knowledgeObjectId: r.payload.knowledge_object_id!,
        documentId: r.payload.document_id ?? '',
        fieldName: r.payload.field_name ?? '',
        score: clamp01(r.score),
      }));
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
