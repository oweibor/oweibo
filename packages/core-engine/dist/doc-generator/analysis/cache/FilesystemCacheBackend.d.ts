import type { ICacheBackend, DocAnalysisCacheEntry } from './ICacheBackend.js';
import type { ILogger } from '../validateGlobPatterns.js';
/**
 * Filesystem backend for DocAnalyzerCache (C5, v10.5).
 *
 * Writes via write-to-temp → rename (atomic on POSIX).
 * Concurrent-writer serialisation via a simple in-process mutex (advisory).
 * On EROFS or any persistent write failure, the caller should fall back to
 * RedisCacheBackend or NullCacheBackend and emit CACHE_BACKEND_FALLBACK.
 */
export declare class FilesystemCacheBackend implements ICacheBackend {
    private readonly cachePath;
    private readonly logger;
    private writing;
    private readonly writeQueue;
    constructor(cachePath: string, logger: ILogger);
    transaction(_key: string, fn: (entries: Record<string, DocAnalysisCacheEntry>) => Record<string, DocAnalysisCacheEntry>): Promise<void>;
    get(key: string): Promise<DocAnalysisCacheEntry | undefined>;
    getAll(): Promise<Record<string, DocAnalysisCacheEntry>>;
    clear(): Promise<void>;
    private readSafe;
    private writeSafe;
    private acquireLock;
    private releaseLock;
}
//# sourceMappingURL=FilesystemCacheBackend.d.ts.map