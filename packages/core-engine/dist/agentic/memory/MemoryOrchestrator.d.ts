/**
 * MemoryOrchestrator — facade that implements IMemoryOrchestrator over the
 * four-tier contract. It owns no storage of its own; every operation routes
 * to one of the injected tiers:
 *
 *   working   → WorkingMemoryRegistry           (tier 1, in-process)
 *   shortTerm → IShortTermMemoryStore           (tier 2, Redis)
 *   projects  → IProjectRegistry                (tier 3, Redis)
 *   semantic  → ISemanticMemoryStore (optional) (tier 4, vector store)
 *
 * The semantic tier is intentionally optional: the contract is usable today
 * with only tiers 1–3 wired up, and `assembleContext` / `record` / `consolidate`
 * degrade gracefully when no vector store is available — calls that would
 * require it return synthesized entries (so the contract still holds) but no
 * vector write actually happens. When a real ISemanticMemoryStore is later
 * supplied (either a native implementation or an adapter over the legacy
 * LongTermMemoryStore) no caller code needs to change.
 *
 * record() routes by kind before falling back to the semantic tier, so the
 * naturally durable kinds land in their proper home:
 *   project-invariant   → ProjectRegistry.setInvariant
 *   conversation-summary → ShortTermMemoryStore.setRollingSummary
 *   everything else     → semantic store, or synthesized if absent.
 */
import type { AssembleContextInput, AssembledContext, ConversationTurn, IMemoryOrchestrator, IProjectRegistry, ISemanticMemoryStore, IShortTermMemoryStore, IWorkingMemory, MemoryEntry, MemoryScope, StoreMemoryInput, TaskOutcome } from '@oweibo/core-contracts';
import { WorkingMemoryRegistry } from './WorkingMemory.js';
/**
 * Summarizer fold the orchestrator calls when STM evicts turns from its
 * sliding window. Receives the previous rolling summary and the just-evicted
 * turns; returns the new rolling summary. Without this hook STM would drop
 * evicted turns silently and the rolling summary would drift out of sync.
 */
export type ConversationSummarizer = (input: {
    readonly previousSummary: string;
    readonly droppedTurns: readonly ConversationTurn[];
}) => Promise<string>;
export interface MemoryOrchestratorDeps {
    readonly working: WorkingMemoryRegistry;
    readonly shortTerm: IShortTermMemoryStore;
    readonly projects: IProjectRegistry;
    /** Optional — when absent, semantic-tier writes/recalls degrade gracefully. */
    readonly semantic?: ISemanticMemoryStore;
    /** Optional — when absent, evicted turns are dropped without summarization. */
    readonly summarizer?: ConversationSummarizer;
}
export declare class MemoryOrchestrator implements IMemoryOrchestrator {
    private readonly deps;
    constructor(deps: MemoryOrchestratorDeps);
    readonly working: (scope: MemoryScope) => IWorkingMemory;
    assembleContext(input: AssembleContextInput): Promise<AssembledContext>;
    recordTurn(scope: MemoryScope, turn: ConversationTurn): Promise<void>;
    record(input: StoreMemoryInput): Promise<MemoryEntry>;
    consolidate(scope: MemoryScope, outcome: TaskOutcome): Promise<readonly MemoryEntry[]>;
    private recall;
    private formatPromptBlock;
}
//# sourceMappingURL=MemoryOrchestrator.d.ts.map