/**
 * MemoryDecayService — scheduled background job for LTM importance decay and eviction.
 *
 * runDecayCycle() is the only public entry point. It scrolls every tenant's Qdrant
 * collection in bounded batches, applies exponential importance decay, archives
 * entries below the eviction threshold to Postgres, and deletes them from Qdrant.
 *
 * Decay model:
 *   λ = ln(2) / kindHalfLife[entry.kind]   (kind-specific decay constant)
 *   newImportance = entry.importance * exp(-λ * daysSinceLastUpdated)
 *
 * Entries whose newImportance drops below decayEvictionThreshold are evicted:
 *   1. Archived to ltm_archive via parameterised bulk INSERT (never string-interpolated).
 *   2. Deleted from Qdrant.
 *
 * Entries above the threshold have their importance updated in-place via setPayload().
 *
 * Concurrency: up to config.maxConcurrentTenants tenants run in parallel (p-limit v3).
 * Archive failures are logged at warn level and must not abort the decay cycle.
 *
 * Phase 2b: Migrated from legacy MemoryEntry/MemoryTier to contract types.
 */
import type { Pool } from 'pg';
import type { MemoryKind } from '@oweibo/core-contracts';
type QdrantClient = any;
export interface DecayConfig {
    kindHalfLife: Partial<Record<MemoryKind, number>>;
    decayEvictionThreshold: number;
    maxPointsPerCyclePerTenant: number;
    interBatchDelayMs: number;
    maxConcurrentTenants: number;
}
export declare const DEFAULT_DECAY_CONFIG: DecayConfig;
export interface Logger {
    info(...a: unknown[]): void;
    warn(...a: unknown[]): void;
    error(...a: unknown[]): void;
    debug(...a: unknown[]): void;
}
export declare class MemoryDecayService {
    private readonly qdrant;
    private readonly pg;
    private readonly config;
    /** Async factory that returns the current list of tenant IDs to process. */
    private readonly tenantIds;
    private readonly logger;
    constructor(qdrant: QdrantClient, pg: Pool, config: DecayConfig, 
    /** Async factory that returns the current list of tenant IDs to process. */
    tenantIds: () => Promise<string[]>, logger: Logger);
    /**
     * runDecayCycle — iterate over all tenants and decay each one's LTM collection.
     *
     * Uses p-limit to cap concurrency at config.maxConcurrentTenants so a large
     * tenant roster does not flood Qdrant with parallel scroll requests.
     */
    runDecayCycle(): Promise<void>;
    /**
     * decayTenant — scroll a tenant's collection in 100-point batches and apply
     * the exponential importance decay formula to each entry.
     *
     * Evicted entries are archived first (best-effort) then deleted from Qdrant.
     * Updates are written with setPayload() so the vector is never re-embedded.
     */
    private decayTenant;
    /**
     * archiveEntries — bulk INSERT evicted entries into ltm_archive.
     *
     * Uses $1…$(6n) parameterised placeholders — entry fields are NEVER
     * string-interpolated into SQL. Errors are swallowed at warn level so
     * archive failure never aborts the decay cycle (entries still get deleted
     * from Qdrant — a missing archive row is preferable to a stuck decay job).
     *
     * Columns archived: id, tenant_id, kind, summary, importance, evicted_at
     */
    private archiveEntries;
}
export {};
//# sourceMappingURL=MemoryDecayService.d.ts.map