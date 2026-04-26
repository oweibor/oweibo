"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingCache = void 0;
const node_crypto_1 = require("node:crypto");
class EmbeddingCache {
    embedder;
    redis;
    ttlSeconds;
    constructor(embedder, redis, ttlSeconds = 86_400) {
        this.embedder = embedder;
        this.redis = redis;
        this.ttlSeconds = ttlSeconds;
    }
    /**
     * embed — returns the embedding for `text`, using the Redis cache when available.
     * On a cache miss the embedding is fetched from the underlying EmbeddingClient,
     * stored in Redis with the configured TTL, and then returned.
     */
    async embed(text) {
        const key = this.cacheKey(text);
        const cached = await this.redis.get(key);
        if (cached !== null) {
            try {
                return JSON.parse(cached);
            }
            catch {
                // Corrupt cache entry — fall through to re-embed
            }
        }
        const embedding = await this.embedder.embed(text);
        await this.redis.setex(key, this.ttlSeconds, JSON.stringify(embedding));
        return embedding;
    }
    // ── Private helpers ────────────────────────────────────────────────────────
    cacheKey(text) {
        const hash = (0, node_crypto_1.createHash)('sha256').update(text).digest('hex').slice(0, 32);
        return `emb:${hash}`;
    }
}
exports.EmbeddingCache = EmbeddingCache;
//# sourceMappingURL=EmbeddingCache.js.map