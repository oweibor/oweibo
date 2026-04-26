/**
 * SemanticMemoryAdapter — implements ISemanticMemoryStore (tier 4 of the new
 * 4-tier contract) by translating to/from the legacy LongTermMemoryStore.
 *
 * The legacy LTM uses a coarser vocabulary:
 *   • 4 MemoryTypes  ('successful-strategy' | 'failure-pattern' | 'tool-heuristic' | 'domain-knowledge')
 *   • 3 MemoryTiers  ('episodic' | 'semantic' | 'procedural')
 *   • Single string scope ('project:{id}', 'task:{id}', 'tenant:{id}', …)
 *
 * The contract uses 11 MemoryKinds and a structured MemoryScope. We bridge the
 * gap by:
 *   1. Mapping each contract MemoryKind to a (type, tier) pair, refusing the
 *      kinds that don't belong in the semantic tier ('user-preference' is
 *      Postgres-only by legacy invariant; 'project-invariant' and
 *      'conversation-summary' are routed to ProjectRegistry / STM by the
 *      orchestrator before reaching this adapter).
 *   2. Stamping the original kind into `relevanceTags` as `kind:{name}` so
 *      recall can recover the precise contract kind on the way back.
 *
 * The adapter exposes only the legacy composite score, so RankedMemoryEntry's
 * scoreBreakdown reports the whole composite under `semantic` and zeros for
 * the other signals — this is honest about what's actually known, and lets
 * a future native implementation populate the breakdown without changing the
 * adapter's interface.
 *
 * purgeTenant / purgeProject throw NotImplementedError. The legacy LTM has
 * no project-scoped delete, and tenant offboarding is handled by Qdrant
 * collection-level tooling — exposing a half-working purge from here would
 * be worse than failing loud.
 */
import type { ISemanticMemoryStore, MemoryEntry, ProjectId, RankedMemoryEntry, RecallQuery, StoreMemoryInput, TenantId } from '@oweibo/core-contracts';
import type { LongTermMemoryStore } from '../LongTermMemoryStore.js';
export declare class SemanticMemoryAdapter implements ISemanticMemoryStore {
    private readonly ltm;
    constructor(ltm: LongTermMemoryStore);
    store(input: StoreMemoryInput): Promise<MemoryEntry>;
    recall(query: RecallQuery): Promise<readonly RankedMemoryEntry[]>;
    purgeTenant(_tenantId: TenantId): Promise<void>;
    purgeProject(_tenantId: TenantId, _projectId: ProjectId): Promise<void>;
    private toRanked;
}
//# sourceMappingURL=SemanticMemoryAdapter.d.ts.map