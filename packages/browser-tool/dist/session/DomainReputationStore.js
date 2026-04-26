"use strict";
/**
 * DomainReputationStore — Redis-cached domain tier pre-classifier.
 * (NEW v9.5.6)
 *
 * Pre-classifies domains before any navigation attempt.
 * Consulted by BrowserBackendRouter as the first routing step.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DomainReputationStore = void 0;
class DomainReputationStore {
    vault;
    redis;
    logger;
    cache = new Map();
    loadedFor = null;
    loadedAt = 0;
    TTL_MS = 5 * 60 * 1_000; // 5-minute cache
    constructor(vault, redis, logger) {
        this.vault = vault;
        this.redis = redis;
        this.logger = logger;
    }
    async getTier(hostname, tenantId) {
        await this.ensureLoaded(tenantId);
        // Exact match first
        const exact = this.cache.get(hostname);
        if (exact)
            return exact.tier;
        // Wildcard parent domain match
        const parts = hostname.split('.');
        for (let i = 1; i < parts.length - 1; i++) {
            const wildcard = `*.${parts.slice(i).join('.')}`;
            const match = this.cache.get(wildcard);
            if (match)
                return match.tier;
        }
        return 'standard';
    }
    /** Force cache invalidation — called by CLI "reputation-reload" command. */
    invalidate() {
        this.loadedAt = 0;
        this.loadedFor = null;
    }
    async ensureLoaded(tenantId) {
        const stale = Date.now() - this.loadedAt > this.TTL_MS;
        const tenantChanged = this.loadedFor !== tenantId;
        if (!stale && !tenantChanged)
            return;
        const [global, tenant] = await Promise.all([
            this.vault.readOptional('oweibo/infra/browser/domain-reputation'),
            this.vault.readOptional(`oweibo/tenants/${tenantId}/browser/domain-reputation`),
        ]);
        this.cache.clear();
        // Load global first; tenant-level entries override global for the same domain
        for (const entry of [...(global ?? []), ...(tenant ?? [])]) {
            this.cache.set(entry.domain, entry);
        }
        this.loadedFor = tenantId;
        this.loadedAt = Date.now();
        this.logger.debug({ tenantId, entries: this.cache.size }, 'DomainReputationStore reloaded.');
    }
}
exports.DomainReputationStore = DomainReputationStore;
//# sourceMappingURL=DomainReputationStore.js.map