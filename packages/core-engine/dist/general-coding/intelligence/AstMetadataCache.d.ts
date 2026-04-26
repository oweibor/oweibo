export interface CacheEntry {
    fileHash: string;
    exports: string[];
    symbols: string[];
    importedBy: string[];
    lastIndexed: string;
}
/**
 * AstMetadataCache — file-hash-keyed persistent cache for CodeIntelligenceLayer.
 *
 * G15 fix: Prevents full re-parse of the entire call graph on every file change.
 * Workflow:
 *   1. On analyzeRepo() / reindexFiles(): compute SHA-256 of each file.
 *   2. If the hash matches the cached entry, skip re-parsing.
 *   3. If the hash is new or missing, re-parse and update the cache entry.
 *   4. flush() writes the updated cache map to disk atomically (tmp+rename).
 *
 * The cache is keyed by absolute file path and is invalidated per-file, not globally.
 */
export declare class AstMetadataCache {
    private readonly repoRoot;
    private cache;
    private readonly cachePath;
    private dirty;
    constructor(repoRoot: string);
    load(): void;
    isStale(filePath: string): boolean;
    get(filePath: string): CacheEntry | undefined;
    set(filePath: string, entry: Omit<CacheEntry, 'fileHash' | 'lastIndexed'>): void;
    flush(): void;
    private hashFile;
}
//# sourceMappingURL=AstMetadataCache.d.ts.map