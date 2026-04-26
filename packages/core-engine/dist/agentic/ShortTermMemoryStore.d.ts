/**
 * ShortTermMemoryStore — two-layer session memory.
 *
 * HOT layer — in-process Map<sessionId, STMEntry[]>.
 *   Zero external I/O. Bounded to stmHotWindowSize entries per session.
 *   Oldest entries are evicted (shift) when the window is exceeded; they remain
 *   in the warm layer. Lost on worker restart — degradation is graceful.
 *
 * WARM layer — Redis Stack HNSW VSS per tenant.
 *   One FT.CREATE index per tenant (stm-idx:{tenantId}), session isolation via
 *   @sessionId TAG filter on FT.SEARCH. Entry keys: stm:{tenantId}:{sessionId}:{id}.
 *   Session counter key: stm-count:{tenantId}:{sessionId}.
 *   Both expire at stmTtlSeconds (default 1h).
 *   Entry-count cap enforced by atomic INCR before write; excess throws StorageCapExceededError.
 *   Requires Redis Stack (redis-stack-server or Redis Cloud with Search module).
 *   Returns empty array on any Redis or parse error — never throws from recall().
 */
import type { Redis } from 'ioredis';
import { EmbeddingCache } from './EmbeddingCache.js';
export declare class StorageCapExceededError extends Error {
    readonly sessionId: string;
    constructor(sessionId: string, message: string);
}
export interface STMEntry {
    id: string;
    tenantId: string;
    userId?: string;
    sessionId: string;
    scope: string;
    summary: string;
    detail: unknown;
    relevanceTags: string[];
    turnIndex: number;
    createdAt: number;
    embedding?: number[];
}
export interface STMHotConfig {
    stmHotWindowSize: number;
    maxStmEntriesPerSession: number;
    stmTtlSeconds: number;
}
export declare const DEFAULT_STM_HOT_CONFIG: STMHotConfig;
export declare class ShortTermMemoryStore {
    private readonly redis;
    private readonly embeddingCache;
    private readonly config;
    private readonly hotLayer;
    constructor(redis: Redis, embeddingCache: EmbeddingCache, config?: STMHotConfig);
    /**
     * store — write to hot layer then warm Redis layer.
     *
     * Execution order:
     *   1. Hot layer push + evict oldest if window full (synchronous, zero I/O).
     *   2. Atomic INCR on session counter → StorageCapExceededError if cap exceeded
     *      (DECR fires-and-forgets before throw to compensate).
     *   3. Embed entry.summary via EmbeddingCache.
     *   4. HSET all fields including binary embedding, EXPIRE the hash key.
     *
     * Returns the assigned id.
     */
    store(entry: Omit<STMEntry, 'id' | 'createdAt'>): Promise<string>;
    /**
     * recallRecent — return the last `limit` entries from the hot layer, newest-last.
     * Synchronous — zero I/O. Returns [] if the session has no hot-layer entries.
     */
    recallRecent({ tenantId: _tenantId, sessionId, limit }: {
        tenantId: string;
        sessionId: string;
        limit: number;
    }): STMEntry[];
    /**
     * recall — warm-layer KNN vector search via Redis FT.SEARCH.
     *
     * Embeds `query`, issues a KNN search on stm-idx:{tenantId} with a @sessionId
     * TAG filter. Results are parsed from the FT.SEARCH response and returned as
     * STMEntry[]. Returns [] on any Redis or parse error — never throws.
     */
    recall({ tenantId, sessionId, query, topK }: {
        tenantId: string;
        sessionId: string;
        query: string;
        topK?: number;
    }): Promise<STMEntry[]>;
    /**
     * destroySession — remove all warm-layer entries for the session, delete the
     * session counter, then clear the hot layer.
     *
     * Uses SCAN (not KEYS) to avoid blocking Redis on large keyspaces.
     */
    destroySession(tenantId: string, sessionId: string): Promise<void>;
}
//# sourceMappingURL=ShortTermMemoryStore.d.ts.map