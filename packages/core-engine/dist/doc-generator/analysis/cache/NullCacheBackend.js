"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullCacheBackend = void 0;
/**
 * In-memory, non-persistent backend. Used when both FilesystemCacheBackend and
 * RedisCacheBackend are unavailable. Every analysis run is cold.
 * Emits CACHE_BACKEND_NULL warning upstream when activated.
 */
class NullCacheBackend {
    store = new Map();
    async transaction(_key, fn) {
        const current = Object.fromEntries(this.store);
        const updated = fn(current);
        this.store.clear();
        for (const [k, v] of Object.entries(updated))
            this.store.set(k, v);
    }
    async get(key) {
        return this.store.get(key);
    }
    async getAll() {
        return Object.fromEntries(this.store);
    }
    async clear() {
        this.store.clear();
    }
}
exports.NullCacheBackend = NullCacheBackend;
//# sourceMappingURL=NullCacheBackend.js.map