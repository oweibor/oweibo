// packages/core-engine/src/general-coding/intelligence/AstMetadataCache.ts
// File-hash-keyed persistent AST cache — sub-200ms warm reindex (§16f.6b, G15)
import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';

export interface CacheEntry {
  fileHash:    string;
  exports:     string[];   // serialised export signatures for RepoMapBuilder reuse
  symbols:     string[];   // top-level symbol names for fast impact lookup
  importedBy:  string[];   // direct importers (caller file paths)
  lastIndexed: string;     // ISO timestamp
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
export class AstMetadataCache {
  private cache:              Map<string, CacheEntry> = new Map();
  private readonly cachePath: string;
  private dirty =             false;

  constructor(private readonly repoRoot: string) {
    this.cachePath = path.join(repoRoot, '.oweibo', 'ast-cache.json');
  }

  load(): void {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as Record<string, CacheEntry>;
      this.cache = new Map(Object.entries(raw));
    } catch {
      this.cache.clear(); // Corrupt cache — start fresh
    }
  }

  isStale(filePath: string): boolean {
    const entry = this.cache.get(filePath);
    if (!entry) return true;
    return this.hashFile(filePath) !== entry.fileHash;
  }

  get(filePath: string): CacheEntry | undefined {
    return this.cache.get(filePath);
  }

  set(filePath: string, entry: Omit<CacheEntry, 'fileHash' | 'lastIndexed'>): void {
    this.cache.set(filePath, {
      ...entry,
      fileHash:    this.hashFile(filePath),
      lastIndexed: new Date().toISOString(),
    });
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    const dir = path.dirname(this.cachePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.cachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cache), null, 2), 'utf8');
    fs.renameSync(tmp, this.cachePath);
    this.dirty = false;
  }

  private hashFile(filePath: string): string {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
      return ''; // file deleted or unreadable — treat as stale
    }
  }
}
