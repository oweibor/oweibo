"use strict";
/**
 * SessionSnapshotStore — persists browser session storage state (cookies + origins)
 * and tab snapshot metadata to Redis for worker-restart resilience.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionSnapshotStore = void 0;
const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const K = {
    snapshot: (tenantId, sessionId) => `oweibo:${tenantId}:browser-snapshot:${sessionId}`,
};
class SessionSnapshotStore {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async save(tenantId, sessionId, snapshot) {
        await this.redis.set(K.snapshot(tenantId, sessionId), JSON.stringify(snapshot), 'EX', SNAPSHOT_TTL_SECONDS);
    }
    async load(tenantId, sessionId) {
        const raw = await this.redis.get(K.snapshot(tenantId, sessionId));
        return raw ? JSON.parse(raw) : null;
    }
    async delete(tenantId, sessionId) {
        await this.redis.del(K.snapshot(tenantId, sessionId));
    }
    async updateStorageState(tenantId, sessionId, storageState) {
        const existing = await this.load(tenantId, sessionId);
        if (!existing)
            return;
        await this.save(tenantId, sessionId, { ...existing, storageState });
    }
}
exports.SessionSnapshotStore = SessionSnapshotStore;
//# sourceMappingURL=SessionSnapshotStore.js.map