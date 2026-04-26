import type { ICacheBackend, DocAnalysisCacheEntry } from './ICacheBackend.js';

/**
 * In-memory, non-persistent backend. Used when both FilesystemCacheBackend and
 * RedisCacheBackend are unavailable. Every analysis run is cold.
 * Emits CACHE_BACKEND_NULL warning upstream when activated.
 */
export class NullCacheBackend implements ICacheBackend {
  private readonly store = new Map<string, DocAnalysisCacheEntry>();

  async transaction(
    _key: string,
    fn: (entries: Record<string, DocAnalysisCacheEntry>) => Record<string, DocAnalysisCacheEntry>,
  ): Promise<void> {
    const current = Object.fromEntries(this.store);
    const updated = fn(current);
    this.store.clear();
    for (const [k, v] of Object.entries(updated)) this.store.set(k, v);
  }

  async get(key: string): Promise<DocAnalysisCacheEntry | undefined> {
    return this.store.get(key);
  }

  async getAll(): Promise<Record<string, DocAnalysisCacheEntry>> {
    return Object.fromEntries(this.store);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
