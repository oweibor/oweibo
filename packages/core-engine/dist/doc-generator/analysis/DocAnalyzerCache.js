"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocAnalyzerCache = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const FilesystemCacheBackend_js_1 = require("./cache/FilesystemCacheBackend.js");
const NullCacheBackend_js_1 = require("./cache/NullCacheBackend.js");
const CACHE_FILE_NAME = 'doc-analyzer-cache.json';
const LEGACY_CACHE_NAME = 'doc-cache.json';
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
class DocAnalyzerCache {
    dotOweiboDir;
    logger;
    backend;
    constructor(dotOweiboDir, logger, backend) {
        this.dotOweiboDir = dotOweiboDir;
        this.logger = logger;
        if (backend) {
            this.backend = backend;
        }
        else {
            const cachePath = `${this.dotOweiboDir}/${CACHE_FILE_NAME}`;
            this.backend = new FilesystemCacheBackend_js_1.FilesystemCacheBackend(cachePath, this.logger);
        }
    }
    /**
     * Migration (A3, v10.3). Must be called once on startup before any reads/writes.
     * Archives legacy .oweibo/doc-cache.json if present.
     */
    async migrateLegacy() {
        const legacyPath = `${this.dotOweiboDir}/${LEGACY_CACHE_NAME}`;
        try {
            await promises_1.default.access(legacyPath);
            const archived = `${legacyPath}.legacy.${Date.now()}`;
            await promises_1.default.rename(legacyPath, archived);
            this.logger.warn({ archived }, 'LEGACY_CACHE_ARCHIVED: pre-v10.3 doc-cache.json archived');
        }
        catch {
            // no legacy file — nothing to do
        }
    }
    /**
     * Returns the cached entry for a file+language pair, or undefined on cache miss.
     * Language is part of the key (CRIT-3) to prevent TS/JS dual-extension collisions.
     */
    async get(filePath, fileHash, language) {
        const key = language ? cacheKey(filePath, language) : cacheKey(filePath, '');
        const entry = await this.backend.get(key);
        if (!entry || entry.fileHash !== fileHash)
            return undefined;
        return entry;
    }
    /** Stores a FileAnalysis in cache, deriving the hash from file content. */
    async set(filePath, content, analysis) {
        const hash = sha256(content);
        const key = cacheKey(filePath, analysis.language);
        const entry = {
            fileHash: hash,
            language: analysis.language,
            richSymbols: analysis.exports,
            imports: analysis.imports,
            exports: analysis.exports,
            complexity: analysis.complexity,
            lineCount: analysis.lineCount,
            lastIndexed: new Date().toISOString(),
        };
        await this.backend.transaction(key, (all) => ({ ...all, [key]: entry }));
    }
    /** Returns ALL cached entries. */
    async getAll() {
        return this.backend.getAll();
    }
    /** Clears the entire cache. */
    async clear() {
        return this.backend.clear();
    }
    /**
     * Creates a DocAnalyzerCache with a FilesystemCacheBackend, falling back to
     * NullCacheBackend if the filesystem is not writable (EROFS).
     */
    static async create(dotOweiboDir, logger, fallback) {
        const cachePath = `${dotOweiboDir}/${CACHE_FILE_NAME}`;
        const fsBackend = new FilesystemCacheBackend_js_1.FilesystemCacheBackend(cachePath, logger);
        try {
            await promises_1.default.mkdir(dotOweiboDir, { recursive: true });
            // Probe writeability with a no-op transaction
            await fsBackend.transaction('__probe__', (e) => e);
            return new DocAnalyzerCache(dotOweiboDir, logger, fsBackend);
        }
        catch (err) {
            const code = err.code;
            if (code === 'EROFS' || code === 'EACCES') {
                logger.warn({ dotOweiboDir }, 'CACHE_BACKEND_FALLBACK: filesystem read-only, using fallback');
                return new DocAnalyzerCache(dotOweiboDir, logger, fallback ?? new NullCacheBackend_js_1.NullCacheBackend());
            }
            logger.warn({ dotOweiboDir }, 'CACHE_BACKEND_NULL: cache unavailable, using null backend');
            return new DocAnalyzerCache(dotOweiboDir, logger, new NullCacheBackend_js_1.NullCacheBackend());
        }
    }
}
exports.DocAnalyzerCache = DocAnalyzerCache;
/** Key format: `${normalizedPath}:${language}` — prevents TS/JS dual-extension collisions (CRIT-3). */
function cacheKey(filePath, language) {
    return `${filePath.replace(/\\/g, '/')}:${language}`;
}
function sha256(content) {
    return node_crypto_1.default.createHash('sha256').update(content).digest('hex');
}
//# sourceMappingURL=DocAnalyzerCache.js.map