/**
 * DomainReputationStore — Redis-cached domain tier pre-classifier.
 * (NEW v9.5.6)
 *
 * Pre-classifies domains before any navigation attempt.
 * Consulted by BrowserBackendRouter as the first routing step.
 */
import type { DomainReputationTier } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
import type { ILogger } from './SessionReaper.js';
interface IVaultClient {
    readOptional(path: string): Promise<unknown>;
}
export declare class DomainReputationStore {
    private readonly vault;
    private readonly redis;
    private readonly logger;
    private readonly cache;
    private loadedFor;
    private loadedAt;
    private readonly TTL_MS;
    constructor(vault: IVaultClient, redis: Redis, logger: ILogger);
    getTier(hostname: string, tenantId: string): Promise<DomainReputationTier>;
    /** Force cache invalidation — called by CLI "reputation-reload" command. */
    invalidate(): void;
    private ensureLoaded;
}
export {};
//# sourceMappingURL=DomainReputationStore.d.ts.map