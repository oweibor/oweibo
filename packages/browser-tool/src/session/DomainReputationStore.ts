/**
 * DomainReputationStore — Redis-cached domain tier pre-classifier.
 * (NEW v9.5.6)
 *
 * Pre-classifies domains before any navigation attempt.
 * Consulted by BrowserBackendRouter as the first routing step.
 */

import type { DomainReputation, DomainReputationTier } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
import type { ILogger } from './SessionReaper.js';

interface IVaultClient {
  readOptional(path: string): Promise<unknown>;
}

export class DomainReputationStore {
  private readonly cache = new Map<string, DomainReputation>();
  private loadedFor: string | null = null;
  private loadedAt = 0;
  private readonly TTL_MS = 5 * 60 * 1_000; // 5-minute cache

  constructor(
    private readonly vault: IVaultClient,
    private readonly redis: Redis,
    private readonly logger: ILogger,
  ) {}

  async getTier(hostname: string, tenantId: string): Promise<DomainReputationTier> {
    await this.ensureLoaded(tenantId);

    // Exact match first
    const exact = this.cache.get(hostname);
    if (exact) return exact.tier;

    // Wildcard parent domain match
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const wildcard = `*.${parts.slice(i).join('.')}`;
      const match = this.cache.get(wildcard);
      if (match) return match.tier;
    }

    return 'standard';
  }

  /** Force cache invalidation — called by CLI "reputation-reload" command. */
  invalidate(): void {
    this.loadedAt = 0;
    this.loadedFor = null;
  }

  private async ensureLoaded(tenantId: string): Promise<void> {
    const stale = Date.now() - this.loadedAt > this.TTL_MS;
    const tenantChanged = this.loadedFor !== tenantId;
    if (!stale && !tenantChanged) return;

    const [global, tenant] = await Promise.all([
      this.vault.readOptional(
        'oweibo/infra/browser/domain-reputation',
      ) as Promise<DomainReputation[] | null>,
      this.vault.readOptional(
        `oweibo/tenants/${tenantId}/browser/domain-reputation`,
      ) as Promise<DomainReputation[] | null>,
    ]);

    this.cache.clear();
    // Load global first; tenant-level entries override global for the same domain
    for (const entry of [...(global ?? []), ...(tenant ?? [])]) {
      this.cache.set(entry.domain, entry);
    }
    this.loadedFor = tenantId;
    this.loadedAt = Date.now();
    this.logger.debug(
      { tenantId, entries: this.cache.size },
      'DomainReputationStore reloaded.',
    );
  }
}
