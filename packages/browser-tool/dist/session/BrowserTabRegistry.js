"use strict";
/**
 * BrowserTabRegistry — Redis-backed tab state store.
 * In-memory Page references (_pageRef) are held only in BrowserSessionManager.
 * (v9.5.3 M1 — fully specified)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserTabRegistry = void 0;
const TAB_TTL_SECONDS = 4 * 60 * 60; // 4 hours
/** Minimal key-builder — avoids raw string templates in application code. */
const K = {
    tab: (tenantId, sessionId, tabId) => `oweibo:browser:${tenantId}:tab:${sessionId}:${tabId}`,
    tabSet: (tenantId, sessionId) => `oweibo:browser:${tenantId}:tabs:${sessionId}`,
};
class BrowserTabRegistry {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async register(tab) {
        await Promise.all([
            this.redis.set(K.tab(tab.tenantId, tab.sessionId, tab.tabId), JSON.stringify(tab), 'EX', TAB_TTL_SECONDS),
            this.redis.sadd(K.tabSet(tab.tenantId, tab.sessionId), tab.tabId),
            this.redis.expire(K.tabSet(tab.tenantId, tab.sessionId), TAB_TTL_SECONDS),
        ]);
    }
    async get(tenantId, sessionId, tabId) {
        const raw = await this.redis.get(K.tab(tenantId, sessionId, tabId));
        return raw ? JSON.parse(raw) : null;
    }
    async list(tenantId, sessionId) {
        const ids = await this.redis.smembers(K.tabSet(tenantId, sessionId));
        const tabs = await Promise.all(ids.map((id) => this.get(tenantId, sessionId, id)));
        return tabs.filter((t) => t !== null);
    }
    async setActive(tenantId, sessionId, tabId) {
        const all = await this.list(tenantId, sessionId);
        await Promise.all(all.map((tab) => this.register({ ...tab, isActive: tab.tabId === tabId })));
    }
    async remove(tenantId, sessionId, tabId) {
        await Promise.all([
            this.redis.del(K.tab(tenantId, sessionId, tabId)),
            this.redis.srem(K.tabSet(tenantId, sessionId), tabId),
        ]);
    }
    async removeAll(tenantId, sessionId) {
        const all = await this.list(tenantId, sessionId);
        await Promise.all(all.map((t) => this.remove(tenantId, sessionId, t.tabId)));
        await this.redis.del(K.tabSet(tenantId, sessionId));
    }
    async updateUrlAndTitle(tenantId, sessionId, tabId, url, title) {
        const tab = await this.get(tenantId, sessionId, tabId);
        if (!tab)
            return;
        await this.register({ ...tab, url, title });
    }
}
exports.BrowserTabRegistry = BrowserTabRegistry;
//# sourceMappingURL=BrowserTabRegistry.js.map