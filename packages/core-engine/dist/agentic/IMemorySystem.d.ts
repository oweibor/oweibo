/**
 * IMemorySystem — unified facade over LTM, STM, warming, and compression.
 *
 * @deprecated **Use `IMemoryOrchestrator` from `@oweibo/core-contracts` instead.**
 *
 * This interface is the legacy memory façade. It has been superseded by the
 * four-tier `IMemoryOrchestrator` contract which models Working / Short-Term /
 * Project / Semantic memory as discrete tiers with hard tenant isolation,
 * typed `MemoryKind` values, and a budget-aware `assembleContext()` facade.
 *
 * Migration:
 *   • Existing code can keep working unchanged by wrapping a `MemoryOrchestrator`
 *     in `LegacyMemorySystemAdapter` (in `agentic/memory/LegacyMemorySystemAdapter.ts`)
 *     and injecting that as the `IMemorySystem`. The adapter translates shapes
 *     and routes both writes and reads through the new orchestrator's tiers.
 *   • New code should depend on `IMemoryOrchestrator` directly. See
 *     `packages/core-engine/src/agentic/memory/MIGRATION.md` for the full
 *     mapping of old → new methods, kinds, and scopes.
 *   • Once all consumers have migrated, this file and `UnifiedMemorySystem`
 *     can be deleted in a single follow-up PR.
 *
 * UnifiedMemorySystem.endSession() is the crash-recovery path (R-4):
 *   1. Check for an existing LTM session entry — skip write if already present
 *      (idempotent: safe to call multiple times, e.g. after a retry).
 *   2. Compress STM via STMCompressor and write to LTM at scope 'session:{id}'.
 *   3. stm.destroySession() is always called in `finally` — not after the catch —
 *      so Redis session keys are torn down regardless of whether the LTM write
 *      succeeded or threw.
 *
 * recall() deduplicates by entry.summary fingerprint (R-10 fix) before returning,
 * using the same logic as MemoryWarmer so callers never see duplicate entries
 * regardless of which channel a memory was surfaced through.
 */
import type { LongTermMemoryStore, MemoryEntry, MemoryTier, MemoryType, RecallResult } from './LongTermMemoryStore.js';
import type { ShortTermMemoryStore } from './ShortTermMemoryStore.js';
import type { MemoryWarmer, WarmResult } from './MemoryWarmer.js';
import type { STMCompressor } from './STMCompressor.js';
import type { Logger } from './MemoryDecayService.js';
/** Input shape for IMemorySystem.store() — sessionId added to route the STM write. */
type NewMemoryWithSession = Omit<MemoryEntry, 'id' | 'successCount' | 'missCount' | 'confidence' | 'createdAt' | 'lastAccessedAt' | 'lastReinforcedAt'> & {
    sessionId: string;
};
/**
 * @deprecated Use `IMemoryOrchestrator` from `@oweibo/core-contracts`.
 * Wrap an orchestrator in `LegacyMemorySystemAdapter` if you need this surface.
 */
export interface IMemorySystem {
    store(entry: NewMemoryWithSession): Promise<string>;
    recall(params: {
        tenantId: string;
        sessionId: string;
        query: string;
        topK?: number;
        minScore?: number;
        tiers?: MemoryTier[];
        types?: MemoryType[];
    }): Promise<RecallResult[]>;
    warmForTask(params: Parameters<MemoryWarmer['warmForTask']>[0]): Promise<WarmResult[]>;
    endSession(tenantId: string, sessionId: string): Promise<void>;
    reinforceMemory(memoryId: string, tenantId: string): Promise<void>;
    penaliseMemory(memoryId: string, tenantId: string): Promise<void>;
}
/**
 * @deprecated Construct a `MemoryOrchestrator` (from `agentic/memory/`) and
 * wrap it in `LegacyMemorySystemAdapter` if you need an `IMemorySystem` shape.
 * UnifiedMemorySystem will be removed once all consumers migrate.
 */
export declare class UnifiedMemorySystem implements IMemorySystem {
    private readonly ltm;
    private readonly stm;
    private readonly warmer;
    private readonly compressor;
    private readonly logger;
    constructor(ltm: LongTermMemoryStore, stm: ShortTermMemoryStore, warmer: MemoryWarmer, compressor: STMCompressor, logger: Logger);
    /**
     * store — write to both STM and LTM.
     *
     * STM receives the full entry including sessionId.
     * LTM receives the entry without sessionId (not part of MemoryEntry shape).
     * Returns the STM id so callers have a short-lived handle for the turn.
     */
    store(entry: NewMemoryWithSession): Promise<string>;
    /**
     * recall — query both LTM and STM, merge, deduplicate, and sort.
     *
     * STM entries are wrapped as RecallResult with a fixed score of 0.90
     * (same STM_SCALE + STM_OFFSET + STM_BOOST composite used in MemoryWarmer)
     * so they sort consistently against LTM composite scores.
     *
     * R-10 fix: deduplication by entry.summary so promoted copies from multiple
     * channels never appear twice in the result set.
     */
    recall(params: {
        tenantId: string;
        sessionId: string;
        query: string;
        topK?: number;
        minScore?: number;
        tiers?: MemoryTier[];
        types?: MemoryType[];
    }): Promise<RecallResult[]>;
    /** Delegate directly to MemoryWarmer. */
    warmForTask(params: Parameters<MemoryWarmer['warmForTask']>[0]): Promise<WarmResult[]>;
    /**
     * endSession — crash-recovery LTM write + STM teardown (R-4).
     *
     * Idempotency check: if an LTM entry at scope 'session:{sessionId}' already
     * exists (written by a previous endSession call or a graceful task completion),
     * the compression + LTM write is skipped.
     *
     * stm.destroySession() is in finally — it runs regardless of whether the LTM
     * write succeeded or threw. If destroySession fails, the error is logged and
     * swallowed; Redis TTL will expire the keys naturally.
     */
    endSession(tenantId: string, sessionId: string): Promise<void>;
    reinforceMemory(memoryId: string, tenantId: string): Promise<void>;
    penaliseMemory(memoryId: string, tenantId: string): Promise<void>;
}
export {};
//# sourceMappingURL=IMemorySystem.d.ts.map