import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ICacheBackend, DocAnalysisCacheEntry } from './ICacheBackend.js';
import type { ILogger } from '../validateGlobPatterns.js';

const CACHE_SCHEMA = 'oweibo.doc-analyzer-cache/v1';

/**
 * Filesystem backend for DocAnalyzerCache (C5, v10.5).
 *
 * Writes via write-to-temp → rename (atomic on POSIX).
 * Concurrent-writer serialisation via a simple in-process mutex (advisory).
 * On EROFS or any persistent write failure, the caller should fall back to
 * RedisCacheBackend or NullCacheBackend and emit CACHE_BACKEND_FALLBACK.
 */
export class FilesystemCacheBackend implements ICacheBackend {
  private writing = false;
  private readonly writeQueue: Array<() => void> = [];

  constructor(
    private readonly cachePath: string,
    private readonly logger:    ILogger,
  ) {}

  async transaction(
    _key: string,
    fn: (entries: Record<string, DocAnalysisCacheEntry>) => Record<string, DocAnalysisCacheEntry>,
  ): Promise<void> {
    await this.acquireLock();
    try {
      const current = await this.readSafe();
      const updated = fn(current);
      await this.writeSafe(updated);
    } finally {
      this.releaseLock();
    }
  }

  async get(key: string): Promise<DocAnalysisCacheEntry | undefined> {
    const all = await this.readSafe();
    return all[key];
  }

  async getAll(): Promise<Record<string, DocAnalysisCacheEntry>> {
    return this.readSafe();
  }

  async clear(): Promise<void> {
    await this.acquireLock();
    try {
      await this.writeSafe({});
    } finally {
      this.releaseLock();
    }
  }

  private async readSafe(): Promise<Record<string, DocAnalysisCacheEntry>> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as { $schema?: string; entries?: Record<string, DocAnalysisCacheEntry> };
      if (parsed.$schema !== CACHE_SCHEMA) {
        this.logger.warn({ schema: parsed.$schema }, 'CACHE_SCHEMA_MISMATCH: treating as empty');
        return {};
      }
      return parsed.entries ?? {};
    } catch {
      return {};
    }
  }

  private async writeSafe(entries: Record<string, DocAnalysisCacheEntry>): Promise<void> {
    const dir = path.dirname(this.cachePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.cachePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const payload = JSON.stringify({ $schema: CACHE_SCHEMA, entries }, null, 2);
    await fs.writeFile(tmp, payload, 'utf-8');
    await fs.rename(tmp, this.cachePath);
  }

  private acquireLock(): Promise<void> {
    if (!this.writing) {
      this.writing = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.writeQueue.push(resolve));
  }

  private releaseLock(): void {
    const next = this.writeQueue.shift();
    if (next) {
      next();
    } else {
      this.writing = false;
    }
  }
}
