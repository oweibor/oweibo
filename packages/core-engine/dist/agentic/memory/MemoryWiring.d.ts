/**
 * MemoryWiring — single entry point that constructs the four-tier memory
 * subsystem from environment-derived config.
 *
 * Closes gap analysis #1 (`MemoryOrchestrator` never instantiated) and #2
 * (`main.ts` stub with `null as never` deps). Replaces the broken inline
 * `new QdrantSemanticStore({ qdrant: null, embedder: null })` with a real
 * orchestrator that gracefully degrades when optional deps are missing:
 *
 *   • Tier 1 (WorkingMemoryRegistry) — always available.
 *   • Tier 2 (ShortTermMemoryStore)  — needs Redis. Always wired here.
 *   • Tier 3 (ProjectRegistry)       — needs Redis. Always wired here.
 *   • Tier 4 (QdrantSemanticStore)   — needs Qdrant + an Embedder. Wired
 *     only when `qdrantUrl` and an embedder are present. Otherwise the
 *     orchestrator omits the semantic tier; `record()` synthesises entries
 *     and `recall()` returns []. The contract still holds.
 *
 * Background services (decay, consolidator, promoter, warmer) are
 * constructed only when their preconditions hold (Qdrant for all four;
 * pg.Pool for decay's archival path). `start()` schedules them on
 * configurable intervals; `stop()` clears all timers.
 */
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { IMemoryOrchestrator, ISemanticMemoryStore } from '@oweibo/core-contracts';
import { type Embedder, type PurgeAuditor } from './QdrantSemanticStore.js';
import { MemoryDecayService, type Logger } from '../MemoryDecayService.js';
import { MemoryConsolidator } from '../MemoryConsolidator.js';
import { MemoryScopePromoter } from '../MemoryScopePromoter.js';
import { MemoryWarmer } from '../MemoryWarmer.js';
export interface MemoryWiringConfig {
    readonly redis: Redis;
    readonly qdrantUrl?: string;
    readonly qdrantApiKey?: string;
    readonly ollamaUrl?: string;
    readonly embedModel?: string;
    readonly vectorDimension?: number;
    readonly pgPool?: Pool;
    /** Used by background services to enumerate tenants needing processing. */
    readonly tenantIds?: () => Promise<string[]>;
    readonly logger?: Logger;
    /** Override an embedder explicitly (skips OllamaEmbedder construction). */
    readonly embedder?: Embedder;
    /**
     * Hook invoked after every successful purgeTenant / purgeProject /
     * purgeUser. Typically wraps `appendAudit()` from @oweibo/db. Declared
     * as a callback so core-engine stays free of DB imports.
     */
    readonly purgeAuditor?: PurgeAuditor;
    /**
     * Configuration for the in-process Qdrant circuit breaker. Pass `false`
     * to disable; pass an object to override the defaults; omit for the
     * defaults (3 failures → 30s cooldown).
     */
    readonly breaker?: false | {
        readonly failureThreshold?: number;
        readonly cooldownMs?: number;
    };
    /**
     * When true, the store throws LegacySchemaError on any pre-existing
     * Qdrant collection that lacks a schema marker (i.e. holds legacy
     * payloads). Default false: warn, write a marker, continue. Useful in
     * environments that have completed legacy migration and want a hard
     * guarantee against new pollution.
     */
    readonly strictSchema?: boolean;
    readonly schedules?: {
        readonly decayMs?: number;
        readonly consolidatorMs?: number;
        readonly promoterMs?: number;
    };
}
export interface MemoryServices {
    decay?: MemoryDecayService;
    consolidator?: MemoryConsolidator;
    promoter?: MemoryScopePromoter;
    warmer?: MemoryWarmer;
}
export interface MemorySubsystem {
    readonly orchestrator: IMemoryOrchestrator;
    readonly semantic: ISemanticMemoryStore | null;
    readonly services: MemoryServices;
    readonly start: () => void;
    readonly stop: () => void;
}
export declare function wireMemorySubsystem(cfg: MemoryWiringConfig): Promise<MemorySubsystem>;
//# sourceMappingURL=MemoryWiring.d.ts.map