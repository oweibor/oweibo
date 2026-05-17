"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCacheBackend = void 0;
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
class RedisCacheBackend {
    redis;
    cacheKey;
    ttlSec;
    constructor(redis, cacheKey, ttlSec = 7 * 24 * 3600) {
        this.redis = redis;
        this.cacheKey = cacheKey;
        this.ttlSec = ttlSec;
    }
    async transaction(key, fn) {
        const raw = await this.redis.hget(this.cacheKey, key);
        const currentEntry = raw ? JSON.parse(raw) : undefined;
        const current = currentEntry ? { [key]: currentEntry } : {};
        const updated = fn(current);
        const newEntry = updated[key];
        if (!newEntry)
            return;
        const newValue = JSON.stringify(newEntry);
        await this.redis.eval(LUA_CAS, 2, this.cacheKey, key, raw ?? 'null', newValue, String(this.ttlSec));
    }
    async get(key) {
        const raw = await this.redis.hget(this.cacheKey, key);
        return raw ? JSON.parse(raw) : undefined;
    }
    async getAll() {
        const raw = await this.redis.hgetall(this.cacheKey);
        if (!raw)
            return {};
        const result = {};
        for (const [k, v] of Object.entries(raw)) {
            try {
                result[k] = JSON.parse(v);
            }
            catch { /* skip corrupt */ }
        }
        return result;
    }
    async clear() {
        await this.redis.del(this.cacheKey);
    }
}
exports.RedisCacheBackend = RedisCacheBackend;
//# sourceMappingURL=RedisCacheBackend.js.map