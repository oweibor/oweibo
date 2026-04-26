/**
 * EmbeddingCache — Redis-backed, SHA-256 keyed embedding cache.
 *
 * Wraps an EmbeddingClient (obtained via ModelRouter.forEmbedding()) with a
 * Redis layer so repeated embeddings of identical text skip the model API call.
 * Typical session hit rate: 60–80%.
 *
 * Cache key format: `emb:{first 32 hex chars of SHA-256(text)}`
 * Default TTL: 24 hours (86 400 s), configurable at construction time.
 */
import type { Redis } from 'ioredis';
import type { EmbeddingClient } from '../infrastructure/ModelRouter.js';
export declare class EmbeddingCache {
    private readonly embedder;
    private readonly redis;
    private readonly ttlSeconds;
    constructor(embedder: EmbeddingClient, redis: Redis, ttlSeconds?: number);
    /**
     * embed — returns the embedding for `text`, using the Redis cache when available.
     * On a cache miss the embedding is fetched from the underlying EmbeddingClient,
     * stored in Redis with the configured TTL, and then returned.
     */
    embed(text: string): Promise<number[]>;
    private cacheKey;
}
//# sourceMappingURL=EmbeddingCache.d.ts.map