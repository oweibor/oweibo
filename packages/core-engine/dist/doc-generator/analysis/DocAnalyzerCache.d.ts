import type { FileAnalysis } from '@oweibo/core-contracts';
import type { ICacheBackend, DocAnalysisCacheEntry } from './cache/ICacheBackend.js';
import type { ILogger } from './validateGlobPatterns.js';
/**
 * DocAnalyzerCache — separate from AstMetadataCache (A3, C5, v10.5).
 *
 * Delegates all storage to an ICacheBackend (default: FilesystemCacheBackend).
 * Owns only key formatting, schema validation, and legacy migration.
 *
 * Legacy coexistence:
 *   .oweibo/ast-metadata-cache.json  — owned by CodeIntelligenceLayer, never touched here
 *   .oweibo/doc-analyzer-cache.json  — this cache
 *   .oweibo/doc-cache.json           — pre-v10.3 artifact; archived on first construct
 */
export declare class DocAnalyzerCache {
    private readonly dotOweiboDir;
    private readonly logger;
    private readonly backend;
    constructor(dotOweiboDir: string, logger: ILogger, backend?: ICacheBackend);
    /**
     * Migration (A3, v10.3). Must be called once on startup before any reads/writes.
     * Archives legacy .oweibo/doc-cache.json if present.
     */
    migrateLegacy(): Promise<void>;
    /**
     * Returns the cached entry for a file+language pair, or undefined on cache miss.
     * Language is part of the key (CRIT-3) to prevent TS/JS dual-extension collisions.
     */
    get(filePath: string, fileHash: string, language?: string): Promise<DocAnalysisCacheEntry | undefined>;
    /** Stores a FileAnalysis in cache, deriving the hash from file content. */
    set(filePath: string, content: string, analysis: FileAnalysis): Promise<void>;
    /** Returns ALL cached entries. */
    getAll(): Promise<Record<string, DocAnalysisCacheEntry>>;
    /** Clears the entire cache. */
    clear(): Promise<void>;
    /**
     * Creates a DocAnalyzerCache with a FilesystemCacheBackend, falling back to
     * NullCacheBackend if the filesystem is not writable (EROFS).
     */
    static create(dotOweiboDir: string, logger: ILogger, fallback?: ICacheBackend): Promise<DocAnalyzerCache>;
}
//# sourceMappingURL=DocAnalyzerCache.d.ts.map