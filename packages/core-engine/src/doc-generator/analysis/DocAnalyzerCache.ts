import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { FileAnalysis } from '@oweibo/core-contracts';
import type { ICacheBackend, DocAnalysisCacheEntry } from './cache/ICacheBackend.js';
import { FilesystemCacheBackend } from './cache/FilesystemCacheBackend.js';
import { NullCacheBackend } from './cache/NullCacheBackend.js';
import type { ILogger } from './validateGlobPatterns.js';

const CACHE_FILE_NAME   = 'doc-analyzer-cache.json';
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
export class DocAnalyzerCache {
  private readonly backend: ICacheBackend;

  constructor(
    private readonly dotOweiboDir: string,
    private readonly logger:       ILogger,
    backend?: ICacheBackend,
  ) {
    if (backend) {
      this.backend = backend;
    } else {
      const cachePath = `${this.dotOweiboDir}/${CACHE_FILE_NAME}`;
      this.backend = new FilesystemCacheBackend(cachePath, this.logger);
    }
  }

  /**
   * Migration (A3, v10.3). Must be called once on startup before any reads/writes.
   * Archives legacy .oweibo/doc-cache.json if present.
   */
  async migrateLegacy(): Promise<void> {
    const legacyPath = `${this.dotOweiboDir}/${LEGACY_CACHE_NAME}`;
    try {
      await fs.access(legacyPath);
      const archived = `${legacyPath}.legacy.${Date.now()}`;
      await fs.rename(legacyPath, archived);
      this.logger.warn({ archived }, 'LEGACY_CACHE_ARCHIVED: pre-v10.3 doc-cache.json archived');
    } catch {
      // no legacy file — nothing to do
    }
  }

  /**
   * Returns the cached entry for a file+language pair, or undefined on cache miss.
   * Language is part of the key (CRIT-3) to prevent TS/JS dual-extension collisions.
   */
  async get(filePath: string, fileHash: string, language?: string): Promise<DocAnalysisCacheEntry | undefined> {
    const key = language ? cacheKey(filePath, language) : cacheKey(filePath, '');
    const entry = await this.backend.get(key);
    if (!entry || entry.fileHash !== fileHash) return undefined;
    return entry;
  }

  /** Stores a FileAnalysis in cache, deriving the hash from file content. */
  async set(filePath: string, content: string, analysis: FileAnalysis): Promise<void> {
    const hash = sha256(content);
    const key  = cacheKey(filePath, analysis.language);
    const entry: DocAnalysisCacheEntry = {
      fileHash:    hash,
      language:    analysis.language,
      richSymbols: analysis.exports,
      imports:     analysis.imports,
      exports:     analysis.exports,
      complexity:  analysis.complexity,
      lineCount:   analysis.lineCount,
      lastIndexed: new Date().toISOString(),
    };
    await this.backend.transaction(key, (all) => ({ ...all, [key]: entry }));
  }

  /** Returns ALL cached entries. */
  async getAll(): Promise<Record<string, DocAnalysisCacheEntry>> {
    return this.backend.getAll();
  }

  /** Clears the entire cache. */
  async clear(): Promise<void> {
    return this.backend.clear();
  }

  /**
   * Creates a DocAnalyzerCache with a FilesystemCacheBackend, falling back to
   * NullCacheBackend if the filesystem is not writable (EROFS).
   */
  static async create(
    dotOweiboDir: string,
    logger:       ILogger,
    fallback?:    ICacheBackend,
  ): Promise<DocAnalyzerCache> {
    const cachePath = `${dotOweiboDir}/${CACHE_FILE_NAME}`;
    const fsBackend = new FilesystemCacheBackend(cachePath, logger);
    try {
      await fs.mkdir(dotOweiboDir, { recursive: true });
      // Probe writeability with a no-op transaction
      await fsBackend.transaction('__probe__', (e) => e);
      return new DocAnalyzerCache(dotOweiboDir, logger, fsBackend);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EROFS' || code === 'EACCES') {
        logger.warn({ dotOweiboDir }, 'CACHE_BACKEND_FALLBACK: filesystem read-only, using fallback');
        return new DocAnalyzerCache(dotOweiboDir, logger, fallback ?? new NullCacheBackend());
      }
      logger.warn({ dotOweiboDir }, 'CACHE_BACKEND_NULL: cache unavailable, using null backend');
      return new DocAnalyzerCache(dotOweiboDir, logger, new NullCacheBackend());
    }
  }
}

/** Key format: `${normalizedPath}:${language}` — prevents TS/JS dual-extension collisions (CRIT-3). */
function cacheKey(filePath: string, language: string): string {
  return `${filePath.replace(/\\/g, '/')}:${language}`;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
