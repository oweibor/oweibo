"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TieredWarmPoolManager = void 0;
const TIER_CONFIGS = {
    hot: { maxSize: 5, maxIdleMs: 5 * 60_000 },
    warm: { maxSize: 10, maxIdleMs: 15 * 60_000 },
    cold: { maxSize: 20, maxIdleMs: 60 * 60_000 },
};
const DEFAULT_LIMITS = {
    cpuCores: 1, memoryMB: 512, diskMB: 1024,
    timeoutMs: 60_000, networkPolicy: 'none',
};
class TieredWarmPoolManager {
    factory;
    pool = [];
    evictTimer = null;
    constructor(factory) {
        this.factory = factory;
    }
    start(evictIntervalMs = 30_000) {
        if (this.evictTimer)
            return;
        this.evictTimer = setInterval(() => this.evictStale(), evictIntervalMs);
    }
    stop() {
        if (this.evictTimer) {
            clearInterval(this.evictTimer);
            this.evictTimer = null;
        }
    }
    async acquire(secCtx, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 10_000;
        const deadline = Date.now() + timeoutMs;
        // Try to find an idle sandbox, preferring hot tier
        for (const tier of ['hot', 'warm', 'cold']) {
            const idx = this.pool.findIndex(e => e.tier === tier && e.acquiredAt === null);
            if (idx !== -1) {
                const entry = this.pool[idx]; // safe: findIndex returned a valid index
                this.pool[idx] = { sandbox: entry.sandbox, tier: entry.tier, acquiredAt: Date.now(), lastUsedAt: entry.lastUsedAt, tenantId: secCtx.tenantId ?? null };
                return entry.sandbox;
            }
        }
        // No idle sandbox — cold-boot a new one if under max pool size
        const totalSize = this.pool.length;
        const maxTotal = TIER_CONFIGS.hot.maxSize + TIER_CONFIGS.warm.maxSize + TIER_CONFIGS.cold.maxSize;
        if (totalSize >= maxTotal) {
            // Wait for one to become available
            const waitStart = Date.now();
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 100));
                const freeIdx = this.pool.findIndex(e => e.acquiredAt === null);
                if (freeIdx !== -1) {
                    const entry = this.pool[freeIdx]; // safe: findIndex returned a valid index
                    this.pool[freeIdx] = { sandbox: entry.sandbox, tier: entry.tier, acquiredAt: Date.now(), lastUsedAt: entry.lastUsedAt, tenantId: secCtx.tenantId ?? null };
                    return entry.sandbox;
                }
            }
            throw new Error(`[WarmPool] acquire() timed out after ${Date.now() - waitStart}ms — all ${maxTotal} slots occupied`);
        }
        const sandbox = await this.factory.createSandbox();
        await sandbox.bootVM(DEFAULT_LIMITS);
        this.pool.push({
            sandbox,
            tier: this.selectTier(),
            acquiredAt: Date.now(),
            lastUsedAt: Date.now(),
            tenantId: secCtx.tenantId ?? null,
        });
        return sandbox;
    }
    async release(sandbox) {
        const idx = this.pool.findIndex(e => e.sandbox === sandbox);
        if (idx === -1)
            return;
        const healthy = await sandbox.healthCheck();
        if (!healthy) {
            await sandbox.destroyVM().catch(() => { });
            this.pool.splice(idx, 1);
            return;
        }
        const current = this.pool[idx]; // safe: idx !== -1 guard above
        this.pool[idx] = {
            sandbox: current.sandbox,
            tier: current.tier,
            acquiredAt: null,
            lastUsedAt: Date.now(),
            tenantId: null,
        };
    }
    async evictStale() {
        const now = Date.now();
        const toEvict = [];
        for (let i = 0; i < this.pool.length; i++) {
            const entry = this.pool[i]; // safe: i < this.pool.length
            if (entry.acquiredAt !== null)
                continue;
            const config = TIER_CONFIGS[entry.tier];
            if (now - entry.lastUsedAt > config.maxIdleMs) {
                toEvict.push(i);
            }
        }
        for (const idx of toEvict.reverse()) {
            const entry = this.pool[idx]; // safe: idx came from the loop above
            await entry.sandbox.destroyVM().catch(() => { });
            this.pool.splice(idx, 1);
        }
    }
    selectTier() {
        const counts = { hot: 0, warm: 0, cold: 0 };
        for (const e of this.pool)
            counts[e.tier]++;
        if (counts.hot < TIER_CONFIGS.hot.maxSize)
            return 'hot';
        if (counts.warm < TIER_CONFIGS.warm.maxSize)
            return 'warm';
        return 'cold';
    }
    get stats() {
        const active = this.pool.filter(e => e.acquiredAt !== null).length;
        return { total: this.pool.length, active, idle: this.pool.length - active };
    }
}
exports.TieredWarmPoolManager = TieredWarmPoolManager;
//# sourceMappingURL=TieredWarmPoolManager.js.map