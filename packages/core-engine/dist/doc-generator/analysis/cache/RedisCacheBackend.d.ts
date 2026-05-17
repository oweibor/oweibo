import type { ICacheBackend, DocAnalysisCacheEntry } from './ICacheBackend.js';
interface RedisClient {
    hget(key: string, field: string): Promise<string | null>;
    hgetall(key: string): Promise<Record<string, string> | null>;
    hset(key: string, field: string, value: string): Promise<number>;
    del(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}
/**
 * Redis backend for DocAnalyzerCache (C5, v10.5).
 *
 * Stores entries as hash fields under `cacheKey`.
 * `transaction()` uses a Lua compare-and-swap script for per-entry optimistic
 * locking — no full-cache lock is needed.
 */
export declare class RedisCacheBackend implements ICacheBackend {
    private readonly redis;
    private readonly cacheKey;
    private readonly ttlSec;
    constructor(redis: RedisClient, cacheKey: string, ttlSec?: number);
    transaction(key: string, fn: (entries: Record<string, DocAnalysisCacheEntry>) => Record<string, DocAnalysisCacheEntry>): Promise<void>;
    get(key: string): Promise<DocAnalysisCacheEntry | undefined>;
    getAll(): Promise<Record<string, DocAnalysisCacheEntry>>;
    clear(): Promise<void>;
}
export {};
//# sourceMappingURL=RedisCacheBackend.d.ts.map