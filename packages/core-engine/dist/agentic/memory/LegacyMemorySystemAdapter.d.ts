/**
 * LegacyMemorySystemAdapter — implements the deprecated `IMemorySystem`
 * (UnifiedMemorySystem's contract) over the new `IMemoryOrchestrator`.
 *
 * # Why this adapter exists
 *
 * Two memory facades coexisted in the codebase:
 *   • Legacy: `IMemorySystem` (in `agentic/IMemorySystem.ts`) implemented by
 *     `UnifiedMemorySystem` over `LongTermMemoryStore + ShortTermMemoryStore +
 *     MemoryWarmer + STMCompressor`.
 *   • New: `IMemoryOrchestrator` (in `@oweibo/core-contracts`) implemented by
 *     `MemoryOrchestrator` over the four-tier contract (`IWorkingMemory`,
 *     `IShortTermMemoryStore`, `IProjectRegistry`, `ISemanticMemoryStore`).
 *
 * The legacy interface had a single live consumer (`ConversationalLoop`) but
 * nothing bridged the two systems — so existing code couldn't migrate without
 * a rewrite, and new code couldn't call into the legacy storage.
 *
 * This adapter is the migration path: existing `IMemorySystem` callers get an
 * implementation backed by the new orchestrator (which itself can be wired
 * over the legacy LTM via `SemanticMemoryAdapter`, so writes still land in
 * the same Qdrant collections). Storage stays unified; only the seam moves.
 *
 * # Lifetime
 *
 * Transitional. Once every `IMemorySystem` caller has been switched to depend
 * on `IMemoryOrchestrator` directly, this file, `IMemorySystem.ts`, and
 * `UnifiedMemorySystem` can all be deleted in one PR.
 *
 * # Shape translation
 *
 * Old → New:
 *   • {tenantId, projectId, sessionId}     → MemoryScope object
 *   • type   ('successful-strategy', …)    → kind  ('success-pattern', …)
 *   • tier   ('episodic'|…)                → dropped (kind subsumes tier semantics)
 *   • relevanceTags: string[]              → stashed in detail.tags so they
 *                                            survive the LTM write via
 *                                            SemanticMemoryAdapter
 *   • importance (not in legacy)           → defaulted to 0.5
 *   • userId                               → dropped (no contract equivalent)
 *
 * New → Old (for recall):
 *   • kind                                 → (type, tier) via the inverse map
 *   • importance                           → confidence
 *   • recallCount                          → successCount; missCount = 0
 *   • createdAt/updatedAt (ISO)            → Unix-ms timestamps
 *   • scope object                         → string ('session:…'/'project:…'/…)
 *
 * # Methods that don't translate cleanly
 *
 *   • warmForTask    — the new orchestrator has no warmer concept; we map it
 *                      to assembleContext + a transformation. Callers that
 *                      depended on warmer-specific scoring (success-rate,
 *                      half-life weights) get a degraded shape — see warmForTask
 *                      docstring.
 *   • reinforceMemory / penaliseMemory — the new contract has no explicit
 *                      reinforce/penalise; SemanticMemoryStore reinforces
 *                      implicitly on `recall({reinforce: true})`. The adapter
 *                      logs at warn level and resolves; behaviour is non-fatal
 *                      to match the legacy expectation that these never throw.
 *   • endSession     — legacy did STM-compression + LTM-write + STM-teardown.
 *                      The new orchestrator's STM has its own TTL-based cleanup,
 *                      so this is a teardown-only no-op by default. Callers that
 *                      hold legacy STM Redis keys outside the orchestrator can
 *                      pass an `endSessionHook` to handle their teardown.
 */
import type { IMemoryOrchestrator, TenantId, SessionId } from '@oweibo/core-contracts';
import type { IMemorySystem } from '../IMemorySystem.js';
import type { RecallResult as LegacyRecallResult } from '../LongTermMemoryStore.js';
import type { WarmResult } from '../MemoryWarmer.js';
interface AdapterLogger {
    warn(msg: string, meta?: Record<string, unknown>): void;
    debug?(msg: string, meta?: Record<string, unknown>): void;
}
export interface LegacyMemorySystemAdapterDeps {
    readonly orchestrator: IMemoryOrchestrator;
    /**
     * Optional teardown for legacy STM keys held outside the orchestrator's STM.
     * Called from endSession() after the orchestrator-level work. Errors are
     * caught and logged — the adapter never lets a teardown failure surface.
     */
    readonly endSessionHook?: (tenantId: TenantId, sessionId: SessionId) => Promise<void>;
    /**
     * Optional structured logger. When omitted, all log calls become no-ops —
     * the adapter never writes to stdout/stderr on its own.
     */
    readonly logger?: AdapterLogger;
}
/**
 * Implements `IMemorySystem` over `IMemoryOrchestrator`.
 * See module-level JSDoc for the full migration story.
 */
export declare class LegacyMemorySystemAdapter implements IMemorySystem {
    private readonly orchestrator;
    private readonly endSessionHook?;
    private readonly logger;
    constructor(deps: LegacyMemorySystemAdapterDeps);
    /**
     * Translate the legacy store-input shape to the contract's StoreMemoryInput
     * and route through `orchestrator.record()`. Returns the new entry's id so
     * callers that retained handles (e.g. for later reinforce calls) keep
     * working — though the new orchestrator does not expose explicit reinforce.
     */
    store(entry: Parameters<IMemorySystem['store']>[0]): Promise<string>;
    /**
     * Translate the legacy recall query shape to `assembleContext`, then convert
     * each `RankedMemoryEntry` back to a legacy `RecallResult`. `minScore` is
     * applied as a post-filter — the contract's recall takes no minScore.
     */
    recall(params: Parameters<IMemorySystem['recall']>[0]): Promise<LegacyRecallResult[]>;
    /**
     * The new orchestrator has no `warmForTask` equivalent — warming was a
     * legacy concept tied to the old MemoryWarmer's heuristic blends. We
     * translate to `assembleContext` and shape the output to match `WarmResult`.
     *
     * Callers that depended on warmer-specific signals (success-rate, half-life
     * weighting) should switch to `assembleContext` directly via the orchestrator
     * for proper score-breakdown access.
     */
    warmForTask(params: Parameters<IMemorySystem['warmForTask']>[0]): Promise<WarmResult[]>;
    /**
     * The legacy implementation did STM compression + LTM crash-recovery write
     * + STM destruction. The new orchestrator's STM has TTL-based cleanup, so
     * the default behaviour is a no-op + optional caller-supplied teardown for
     * legacy Redis keys held outside the orchestrator.
     *
     * Always non-throwing — matches the legacy contract that endSession failure
     * never surfaces to callers.
     */
    endSession(tenantId: TenantId, sessionId: SessionId): Promise<void>;
    /**
     * No-op + warn. The new orchestrator has no explicit reinforce/penalise:
     * `ISemanticMemoryStore.recall({reinforce: true})` bumps recallCount
     * implicitly. Callers that need explicit reinforcement should switch to
     * `IMemoryOrchestrator` (and back the orchestrator with a semantic store
     * that supports it) directly.
     *
     * Resolves successfully so legacy fire-and-forget patterns don't crash.
     */
    reinforceMemory(memoryId: string, tenantId: TenantId): Promise<void>;
    penaliseMemory(memoryId: string, tenantId: TenantId): Promise<void>;
    private rankedToLegacyRecallResult;
    /**
     * Build a legacy MemoryEntry from a contract RankedMemoryEntry. Fields the
     * contract doesn't carry (missCount, lastAccessedAt, lastReinforcedAt) are
     * synthesised from the contract's coarser timestamps. relevanceTags is
     * recovered from `detail.tags` if the original write used the smuggle path.
     */
    private rankedToLegacyEntry;
}
export {};
//# sourceMappingURL=LegacyMemorySystemAdapter.d.ts.map