/**
 * LongTermMemoryStore — Qdrant-backed semantic memory for agent recall.
 *
 * §2 data model + §4 EmbeddingCache wiring + §5 store / reinforce.
 * recall() and consolidateFromTask() follow in subsequent phases.
 *
 * Scope conventions (enforced by TenantKeyBuilder — never construct raw scope strings):
 *   'user:{userId}'        — per-user episodic events (e.g. "user completed onboarding").
 *                            NOT used for preferences — those live in Postgres user_preferences.
 *                            Recalled semantically like any other scope.
 *   'project:{projectId}'  — project-specific architecture, conventions, decisions
 *                            (recalled with higher boost than tenant-wide memories)
 *   'tenant:{tenantId}'    — tenant-wide shared knowledge (promoted procedural memories)
 *   '{role}:{taskId}'      — agent-role-scoped episodic memories for a specific task
 *   'session:{sessionId}'  — crash-recovery LTM write (written by endSession recovery path)
 */
import type { Plan, DecisionLog } from '@oweibo/core-contracts';
import { EmbeddingCache } from './EmbeddingCache.js';
type QdrantClient = any;
/**
 * Thrown by store() when the tenant's Qdrant collection has reached
 * config.maxLtmEntriesPerTenant. Decay must run before new entries can be written.
 */
export declare class LtmCapExceededError extends Error {
    constructor(message: string);
}
export type MemoryType = 'successful-strategy' | 'failure-pattern' | 'tool-heuristic' | 'domain-knowledge';
/**
 * MemoryTier — governs decay rate and consolidation eligibility.
 *
 *  episodic   — "what happened in task X"       — fast decay   (7-day  half-life)
 *  semantic   — "what we know is generally true" — slow decay   (90-day half-life)
 *  procedural — "how to do X reliably"           — very slow    (180-day half-life)
 */
export type MemoryTier = 'episodic' | 'semantic' | 'procedural';
export interface MemoryEntry {
    id: string;
    tenantId: string;
    userId?: string;
    projectId?: string;
    scope: string;
    type: MemoryType;
    tier: MemoryTier;
    summary: string;
    detail: unknown;
    relevanceTags: string[];
    successCount: number;
    missCount: number;
    confidence: number;
    createdAt: number;
    lastAccessedAt: number;
    lastReinforcedAt: number;
    promotedToId?: string;
    consolidatedAt?: number;
}
/** Typed recall result — includes composite score for caller-side confidence gating. */
export interface RecallResult {
    entry: MemoryEntry;
    score: number;
}
export interface LongTermMemoryConfig {
    /** Composite score weights — must sum to 1.0 */
    similarityWeight: number;
    recencyWeight: number;
    successWeight: number;
    recencyHalfLifeDays: number;
    deduplicationThreshold: number;
    promotionThreshold: number;
    decayEvictionThreshold: number;
    tierHalfLife: Record<MemoryTier, number>;
    enableGovernanceScan: boolean;
    maxPointsPerCyclePerTenant: number;
    batchSize: number;
    interBatchDelayMs: number;
    maxConcurrentTenants: number;
    /**
     * Hard LLM call budget for MemoryConsolidator per tenant per cycle.
     * Without this cap a tenant with many distinct relevanceTags fires one LLM call
     * per qualifying cluster — unbounded at scale. Clusters are sorted by size
     * (largest first) so the highest-value consolidations always run within the cap.
     * Overridable per-tenant via Vault: oweibo/tenants/{tenantId}/memory/consolidation
     * (alongside windowDays and minClusterSize).
     */
    maxClustersPerCyclePerTenant: number;
    /**
     * Hot STM layer: number of most-recent turns kept in-process per (tenantId, sessionId).
     * Recall over this window is a linear cosine scan — zero external I/O beyond embedding.
     * Older turns are evicted from the hot layer (they remain in the warm Redis VSS layer).
     */
    stmHotWindowSize: number;
    /**
     * Warm STM layer: maximum total entries per session in the Redis VSS index.
     * Enforced via atomic INCR on a per-session counter key before each write.
     * StorageCapExceededError is thrown if exceeded; the counter key shares the
     * session TTL so it expires automatically when the session does.
     */
    maxStmEntriesPerSession: number;
    /**
     * Maximum LTM entries per tenant Qdrant collection.
     * Enforced at store() time: if the collection already holds this many points,
     * store() throws LtmCapExceededError instead of upserting. Decay runs nightly
     * and should keep collections well below this ceiling in normal operation;
     * the cap is a hard backstop against runaway episodic writes.
     */
    maxLtmEntriesPerTenant: number;
    /**
     * Maximum tokens allocated to the userProfile fixed prompt block.
     * UserProfileStore truncates the rendered profile to this limit before returning.
     * Kept deliberately small — a well-structured profile is 200–500 tokens.
     * This block is always injected and never competes with warmMemory for budget.
     */
    userProfileTokenCap: number;
    /**
     * PreferenceNudgeService config — controls session-end preference detection.
     * Per-tenant overridable via Vault at oweibo/tenants/{tenantId}/memory/nudge.
     */
    nudgeMinConfidence: number;
    nudgeMaxTurns: number;
}
export declare const DEFAULT_LTM_CONFIG: LongTermMemoryConfig;
/** Input shape for store() — server-assigned fields are derived internally. */
type NewMemoryEntry = Omit<MemoryEntry, 'id' | 'successCount' | 'missCount' | 'confidence' | 'createdAt' | 'lastAccessedAt' | 'lastReinforcedAt'>;
export declare class LongTermMemoryStore {
    private readonly qdrant;
    private readonly embeddingCache;
    private readonly config;
    constructor(qdrant: QdrantClient, embeddingCache: EmbeddingCache, config?: LongTermMemoryConfig);
    /**
     * embed — cache-aware embedding via EmbeddingCache.
     * Single call-site: all methods that need a vector go through here so cache
     * behaviour is centralised and the hot path is never duplicated.
     */
    private embed;
    /**
     * Store a memory entry.
     *
     * Execution order (all I/O after guards):
     *   1. Scope invariant guard — user: scope + isPreference flag → throw before any I/O.
     *   2. Cap check             — points_count >= maxLtmEntriesPerTenant → LtmCapExceededError.
     *   3. Embed                 — single embed() call reused for dedup search and upsert.
     *   4. Dedup                 — cosine > deduplicationThreshold in same scope → reinforce
     *                              existing entry and return its id (no new point written).
     *   5. Upsert                — new point with server-assigned id and zero counters.
     *
     * Returns the id of the stored (or reinforced) entry.
     */
    store(entry: NewMemoryEntry): Promise<string>;
    /**
     * Reinforce — increment successCount and recompute confidence using Laplace smoothing.
     * Updates lastAccessedAt and lastReinforcedAt timestamps.
     * Uses qdrant.setPayload() only — no re-embedding (gap G-M4 fix).
     *
     * Note: cross-scope promotion (§8 MemoryScopePromoter) is wired in a later phase.
     */
    reinforce(memoryId: string, tenantId: string): Promise<void>;
    /**
     * Penalise — increment missCount (entry was recalled but did not help).
     * Reduces confidence, accelerating decay for consistently unhelpful memories.
     * Symmetric with reinforce(): qdrant.setPayload() only — no re-embedding.
     */
    penalise(memoryId: string, tenantId: string): Promise<void>;
    /**
     * Semantic recall with composite scoring.
     *
     * Fetches `topK * 3` candidates from Qdrant (over-fetch to allow re-ranking),
     * then re-ranks every candidate with:
     *
     *   score = config.similarityWeight  · cosine
     *         + config.recencyWeight     · recencyBoost
     *         + config.successWeight     · entry.confidence
     *
     * where:
     *   recencyBoost = Math.exp(-daysSinceLastAccess / config.recencyHalfLifeDays)
     *   entry.confidence is Laplace-smoothed success rate maintained by reinforce()
     *
     * All three weights are read exclusively from `this.config` — never hardcoded.
     * (config.successWeight is what the spec also calls "successRateWeight".)
     *
     * Results are filtered by minScore, sorted descending, and sliced to topK.
     * After the result set is assembled, a fire-and-forget setPayload() updates
     * lastAccessedAt on every returned entry (R-14 fix — must not block return).
     */
    recall(tenantId: string, query: string, options?: {
        types?: MemoryType[];
        tiers?: MemoryTier[];
        scope?: string;
        topK?: number;
        minScore?: number;
    }): Promise<RecallResult[]>;
    /**
     * consolidateFromTask — persist a successful plan strategy and its decision log
     * to long-term memory after task completion.
     *
     * Writes in two batches via Promise.all (G-M10 — no sequential await per entry):
     *   1. One 'successful-strategy' entry summarising the plan (tier: semantic).
     *   2. One 'tool-heuristic' entry per DecisionLog item (tier: episodic).
     *      Memory-recall decisions (stage === 'memory') are skipped — they are
     *      observations about retrieval, not reusable heuristics.
     *
     * Scope is 'tenant:{tenantId}' so the knowledge is available tenant-wide.
     * TODO §18: replace tenantId placeholder once IAgentTask carries tenantId.
     */
    consolidateFromTask(plan: Plan, decisionLog: DecisionLog[], tenantId: string): Promise<void>;
}
export {};
//# sourceMappingURL=LongTermMemoryStore.d.ts.map