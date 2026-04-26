import type { ICacheBackend, DocAnalysisCacheEntry } from './ICacheBackend.js';

interface RedisClient {
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}

const LUA_CAS = `
local current = redis.call('HGET', KEYS[1], KEYS[2])
if current == false or current == ARGV[1] then
  redis.call('HSET', KEYS[1], KEYS[2], ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0
`.trim();

/**
 * Redis backend for DocAnalyzerCache (C5, v10.5).
 *
 * Stores entries as hash fields under `cacheKey`.
 * `transaction()` uses a Lua compare-and-swap script for per-entry optimistic
 * locking — no full-cache lock is needed.
 */
export class RedisCacheBackend implements ICacheBackend {
  constructor(
    private readonly redis:    RedisClient,
    private readonly cacheKey: string,
    private readonly ttlSec:   number = 7 * 24 * 3600,
  ) {}

  async transaction(
    key: string,
    fn: (entries: Record<string, DocAnalysisCacheEntry>) => Record<string, DocAnalysisCacheEntry>,
  ): Promise<void> {
    const raw = await this.redis.hget(this.cacheKey, key);
    const currentEntry: DocAnalysisCacheEntry | undefined = raw ? JSON.parse(raw) : undefined;
    const current: Record<string, DocAnalysisCacheEntry> = currentEntry ? { [key]: currentEntry } : {};
    const updated = fn(current);
    const newEntry = updated[key];
    if (!newEntry) return;

    const newValue = JSON.stringify(newEntry);
    await this.redis.eval(
      LUA_CAS, 2,
      this.cacheKey, key,
      raw ?? 'null', newValue, String(this.ttlSec),
    );
  }

  async get(key: string): Promise<DocAnalysisCacheEntry | undefined> {
    const raw = await this.redis.hget(this.cacheKey, key);
    return raw ? (JSON.parse(raw) as DocAnalysisCacheEntry) : undefined;
  }

  async getAll(): Promise<Record<string, DocAnalysisCacheEntry>> {
    const raw = await this.redis.hgetall(this.cacheKey);
    if (!raw) return {};
    const result: Record<string, DocAnalysisCacheEntry> = {};
    for (const [k, v] of Object.entries(raw)) {
      try { result[k] = JSON.parse(v) as DocAnalysisCacheEntry; } catch { /* skip corrupt */ }
    }
    return result;
  }

  async clear(): Promise<void> {
    await this.redis.del(this.cacheKey);
  }
}
