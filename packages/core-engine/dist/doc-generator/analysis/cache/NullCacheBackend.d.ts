import type { ICacheBackend, DocAnalysisCacheEntry } from './ICacheBackend.js';
/**
 * In-memory, non-persistent backend. Used when both FilesystemCacheBackend and
 * RedisCacheBackend are unavailable. Every analysis run is cold.
 * Emits CACHE_BACKEND_NULL warning upstream when activated.
 */
export declare class NullCacheBackend implements ICacheBackend {
    private readonly store;
    transaction(_key: string, fn: (entries: Record<string, DocAnalysisCacheEntry>) => Record<string, DocAnalysisCacheEntry>): Promise<void>;
    get(key: string): Promise<DocAnalysisCacheEntry | undefined>;
    getAll(): Promise<Record<string, DocAnalysisCacheEntry>>;
    clear(): Promise<void>;
}
//# sourceMappingURL=NullCacheBackend.d.ts.map