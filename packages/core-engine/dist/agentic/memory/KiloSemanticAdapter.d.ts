/**
 * KiloSemanticAdapter — implements ISemanticMemoryStore (tier 4 of the new
 * 4-tier contract) on top of kilo's existing Qdrant collection layout.
 *
 * Kilo runs three "ambient" semantic Qdrant collections:
 *   • project_decisions   — promoted ADRs (architectural decisions)
 *   • project_reasoning   — decision-rationale entries
 *   • project_history     — pipeline stage outputs and other episodic memory
 *
 * (Kilo also runs project_invariants, but that collection holds machine-
 * evaluable gate rules with their own promotion/decay/false-positive
 * machinery — NOT the same concept as the contract's `Project.invariants`
 * key/value facts. The adapter intentionally never reads or writes
 * project_invariants; project-invariant kinds are routed to ProjectRegistry
 * by the MemoryOrchestrator before they ever reach this adapter.)
 *
 * Schema this adapter writes (all payloads):
 *   {
 *     tenant_id:    string,          // snake_case to match kilo's convention
 *     project_id?:  string,
 *     scope?:       string,          // free-form scope label (e.g. 'task:abc')
 *     kind:         MemoryKind,      // contract enum, stamped for round-trip
 *     summary:      string,
 *     body?:        string,
 *     detail?:      object,
 *     importance:   number,
 *     created_at:   ISO string,
 *     updated_at:   ISO string,
 *     recall_count: number,
 *     _source:      'oweibo-semantic-adapter/v1',
 *   }
 *
 * Recall is tolerant of legacy entries that predate the adapter (e.g. items
 * written by pipelineMemoryAdapter.storeStageOutput before this adapter
 * existed): missing `kind` is inferred from the source collection.
 *
 * Construction takes a Qdrant client + embedder rather than instantiating
 * either itself, so kilo can pass its existing services and other consumers
 * can wire their own.
 */
import type { ISemanticMemoryStore, MemoryEntry, ProjectId, RankedMemoryEntry, RecallQuery, StoreMemoryInput, TenantId, UserId } from '@oweibo/core-contracts';
type QdrantClientLike = any;
export type Embedder = (text: string) => Promise<number[]>;
export interface KiloSemanticAdapterDeps {
    readonly qdrant: QdrantClientLike;
    readonly embedder: Embedder;
}
export declare class KiloSemanticAdapter implements ISemanticMemoryStore {
    private readonly deps;
    constructor(deps: KiloSemanticAdapterDeps);
    store(input: StoreMemoryInput): Promise<MemoryEntry>;
    recall(query: RecallQuery): Promise<readonly RankedMemoryEntry[]>;
    purgeTenant(tenantId: TenantId): Promise<void>;
    purgeProject(tenantId: TenantId, projectId: ProjectId): Promise<void>;
    purgeUser(tenantId: TenantId, userId: UserId): Promise<void>;
    private toRanked;
}
export {};
//# sourceMappingURL=KiloSemanticAdapter.d.ts.map