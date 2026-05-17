/**
 * QdrantSemanticStore — native ISemanticMemoryStore implementation (tier 4).
 *
 * Replaces the legacy SemanticMemoryAdapter → LongTermMemoryStore translation
 * chain with a single, contract-native Qdrant client that:
 *
 *   1. Stores the contract's MemoryKind directly in the payload — no lossy
 *      mapping to/from legacy MemoryType/MemoryTier.
 *   2. Computes a full composite scoreBreakdown on recall (semantic, recency,
 *      importance, kindBoost, mmrPenalty) rather than zeroing everything except
 *      the raw cosine score.
 *   3. Implements purgeTenant and purgeProject natively via Qdrant's filtered
 *      delete — no more NotImplementedError.
 *   4. Enforces deduplication (cosine > threshold in same scope → reinforce)
 *      and per-tenant entry caps at store time.
 *   5. Performs fire-and-forget reinforcement on recall (recall_count++,
 *      updated_at bump) without blocking the return path.
 *
 * Collection naming reuses TenantKeyBuilder.ltmCollection(tenantId) so existing
 * Qdrant data written by LongTermMemoryStore is accessible (though the payload
 * schema is different — legacy entries will have missing fields that are
 * defaulted gracefully in toRanked()).
 *
 * Construction follows the KiloSemanticAdapter pattern: inject a Qdrant client
 * and an embedder function. Callers wrap EmbeddingCache.embed() as the embedder
 * if they want Redis-backed caching.
 */
import type { ISemanticMemoryStore, MemoryEntry, MemoryKind, ProjectId, RankedMemoryEntry, RecallQuery, StoreMemoryInput, TenantId, UserId } from '@oweibo/core-contracts';
import { MemoryCircuitBreaker } from './MemoryCircuitBreaker.js';
type QdrantClient = any;
/** Embedder function — accepts text, returns a float vector. */
export type Embedder = (text: string) => Promise<number[]>;
/**
 * Audit hook fired after a destructive operation succeeds. Implementations
 * typically call appendAudit() — declared as a callback to keep core-engine
 * free of @oweibo/db imports (the storage layer doesn't know about Postgres).
 */
export type PurgeAuditor = (event: PurgeAuditEvent) => void | Promise<void>;
export interface PurgeAuditEvent {
    readonly action: 'memory.tenant.purge' | 'memory.project.purge' | 'memory.user.purge';
    readonly tenantId: string;
    readonly projectId?: string;
    readonly userId?: string;
    /** Wall-clock timestamp the purge completed. */
    readonly ts: Date;
}
export interface QdrantSemanticStoreConfig {
    /** Cosine similarity threshold for deduplication (default: 0.93). */
    readonly deduplicationThreshold: number;
    /** Max entries per tenant collection (default: 100_000). */
    readonly maxEntriesPerTenant: number;
    /** Recency half-life in days for composite scoring (default: 14). */
    readonly recencyHalfLifeDays: number;
    /** Composite score weights — must sum to ≤ 1.0. */
    readonly weights: {
        readonly semantic: number;
        readonly recency: number;
        readonly importance: number;
        readonly kindBoost: number;
    };
    /** Per-kind boost multipliers applied to the kindBoost weight. */
    readonly kindBoosts: Partial<Record<MemoryKind, number>>;
    /** Over-fetch multiplier for recall (default: 3). */
    readonly overFetchMultiplier: number;
    /**
     * MMR (Maximal Marginal Relevance) diversity coefficient in [0, 1].
     *
     *   1.0 — pure relevance; results sorted by composite score (no MMR).
     *   0.7 — default; mild diversity bias, moderate near-duplicate suppression.
     *   0.5 — equal weight to relevance and diversity.
     *   0.0 — pure diversity; after the first (highest-relevance) pick, every
     *         subsequent pick is whichever candidate is most different from
     *         what's already been selected.
     *
     * Without MMR, two near-duplicate facts can both crowd into the top-k
     * results. With MMR, the duplicate's marginal contribution is penalised
     * by its similarity to the already-selected, so a more diverse alternative
     * wins. Carbonell & Goldstein 1998 — implemented greedily.
     */
    readonly mmrLambda: number;
    /**
     * Embedding vector dimension used when auto-creating a tenant collection
     * (default: 1536, matching text-embedding-ada-002 / text-embedding-3-small).
     * Must match the embedder's output dimension.
     */
    readonly vectorDimension: number;
    /**
     * Identifier of the embedder model — recorded in the schema marker so
     * future callers can detect embedder swaps even when dimensions happen
     * to match. Free-form (e.g. `'ollama:nomic-embed-text'`).
     */
    readonly embedderId?: string;
    /**
     * Strict schema mode — when true, throw LegacySchemaError on any
     * collection that exists but has no schema marker (legacy data),
     * blocking writes that would extend pollution. When false (default),
     * write the marker on-the-fly and emit a console.warn so operators
     * notice. Read paths are always permissive.
     */
    readonly strictSchema?: boolean;
}
/**
 * Thrown by store() when the tenant's Qdrant collection has reached
 * config.maxEntriesPerTenant. Decay must run before new entries can be written.
 */
export declare class SemanticStoreCapExceededError extends Error {
    constructor(tenantId: string, cap: number);
}
/**
 * Thrown when a tenant's existing Qdrant collection has a schema that's
 * incompatible with the current store config — typically the collection
 * was created with a different embedder dimension than this process is
 * configured to produce. Continuing would silently corrupt search results.
 */
export declare class SchemaIncompatibleError extends Error {
    constructor(message: string);
}
/**
 * Thrown (in strict mode) when a collection exists but has no schema
 * marker — the entries predate this store's payload schema and recall
 * results will silently default missing fields. Set `strictSchema: false`
 * to downgrade this to a one-time warning during which the marker is
 * written and operation continues.
 */
export declare class LegacySchemaError extends Error {
    constructor(message: string);
}
export interface QdrantSemanticStoreDeps {
    readonly qdrant: QdrantClient;
    readonly embedder: Embedder;
    readonly config?: Partial<QdrantSemanticStoreConfig>;
    /**
     * Optional in-process circuit breaker. When supplied, every Qdrant call
     * is gated by `breaker.exec(...)`; sustained failures trip the breaker
     * and subsequent calls fast-fail with MemoryCircuitOpenError until the
     * cooldown elapses.
     */
    readonly breaker?: MemoryCircuitBreaker;
    /**
     * Optional purge audit hook. When supplied, fires after a successful
     * purgeTenant / purgeProject / purgeUser. Errors thrown by the auditor
     * are caught and logged — they never undo the purge.
     */
    readonly audit?: PurgeAuditor;
}
export declare class QdrantSemanticStore implements ISemanticMemoryStore {
    private readonly deps;
    private readonly config;
    /**
     * Serialises the cap-check + upsert sequence per tenant within this
     * process. Closes gap #11 (TOCTOU): two concurrent stores for the same
     * tenant could each read points_count=cap-1 and both upsert, exceeding
     * the cap. Different tenants run concurrently as before.
     */
    private readonly writeSerializer;
    /**
     * Serialises retrieve+setPayload per point. Closes gap #12: concurrent
     * recalls of the same point would each read recall_count=N and both
     * setPayload(N+1), losing one increment.
     */
    private readonly reinforceSerializer;
    constructor(deps: QdrantSemanticStoreDeps);
    /**
     * store — embed, deduplicate, and upsert a memory entry.
     *
     * Execution order:
     *   1. Kind guard — reject kinds owned by other tiers.
     *   2. Cap check — fail fast before embedding if collection is full.
     *   3. Embed — single embed() call reused for dedup and upsert.
     *   4. Dedup — cosine > threshold in same tenant+scope → reinforce existing.
     *   5. Upsert — new point with contract-native payload.
     */
    store(input: StoreMemoryInput): Promise<MemoryEntry>;
    /**
     * recall — semantic search with full composite scoring + MMR diversity.
     *
     * Over-fetches from Qdrant, computes a base relevance score per candidate:
     *   relevance = w_semantic   · cosine
     *             + w_recency    · exp(-daysSinceUpdate / halfLifeDays)
     *             + w_importance · entry.importance
     *             + w_kindBoost  · kindBoostMultiplier
     *
     * If `mmrLambda < 1`, the final selection runs greedy MMR over the
     * candidate set (Carbonell & Goldstein 1998):
     *
     *   MMR(D) = λ · relevance(D) - (1-λ) · max sim(D, S) for S already selected
     *
     * which suppresses near-duplicate clusters by penalising candidates that
     * are too similar to already-selected results. With `mmrLambda = 1.0`,
     * MMR is disabled and the top-k pure-relevance ranking is returned.
     *
     * Fire-and-forget reinforcement (recall_count++, updated_at bump) runs
     * after the result set is assembled — must not block the return path.
     */
    recall(query: RecallQuery): Promise<readonly RankedMemoryEntry[]>;
    /**
     * purgeTenant — hard delete all memories for a tenant.
     * Filters by tenant_id across the tenant's collection.
     */
    purgeTenant(tenantId: TenantId): Promise<void>;
    /**
     * purgeProject — hard delete all memories scoped to a specific project
     * without affecting the rest of the tenant's data.
     */
    purgeProject(tenantId: TenantId, projectId: ProjectId): Promise<void>;
    /**
     * purgeUser — hard delete all memories authored by a single user inside a
     * tenant. Used for per-user GDPR erasure when the user shares the tenant
     * with other members. Memories without a user_id (legacy or system-authored)
     * are left untouched.
     */
    purgeUser(tenantId: TenantId, userId: UserId): Promise<void>;
    /**
     * qcall — run a Qdrant client call through the optional circuit breaker.
     * Without a breaker this is a transparent passthrough. With a breaker,
     * sustained failures trip it and subsequent calls fast-fail with
     * MemoryCircuitOpenError until the cooldown elapses.
     */
    private qcall;
    /**
     * fireAudit — invoke the optional purge auditor without letting its
     * failures undo the destructive operation. Must be called only AFTER the
     * underlying delete has succeeded.
     */
    private fireAudit;
    /**
     * ensureCollection — create the tenant's Qdrant collection if it doesn't
     * exist yet. Idempotent: swallows "already exists" errors from Qdrant.
     * Called at the top of store() so the first write for a new tenant
     * auto-provisions the collection rather than crashing with a 404.
     */
    private ensureCollection;
    /**
     * readSchemaMarker — fetch the per-collection schema marker payload.
     * Returns null when the marker point is absent (legacy collection or
     * fresh creation in progress).
     */
    private readSchemaMarker;
    /**
     * writeSchemaMarker — upsert the per-collection schema marker. Idempotent:
     * uses the fixed SCHEMA_MARKER_ID so repeated calls overwrite in place.
     * The marker carries no `tenant_id`, so recall (which filters by tenant_id)
     * never surfaces it as a result, and purge* won't delete it.
     */
    private writeSchemaMarker;
    /**
     * reinforcePoint — increment recall_count and bump updated_at.
     * Fire-and-forget; never throws to the caller.
     */
    private reinforcePoint;
    /**
     * computeBreakdown — calculate individual score components for auditability.
     * `mmrPenalty` is initialised to 0 here and overwritten by selectByMMR
     * for results that survive into the final selection.
     */
    private computeBreakdown;
    /**
     * selectByMMR — greedy Maximal Marginal Relevance selection.
     *
     * On each iteration, score every remaining candidate as
     *   λ · relevance(c) - (1-λ) · max sim(c, s) over all already-selected s
     * and pick the highest scorer. Continues until topK reached or candidates
     * exhausted. Mutates each selected candidate's `breakdown.mmrPenalty` to
     * record the actual penalty applied (negative = discouraged for being
     * too similar to earlier picks).
     *
     * Candidates without a vector (legacy entries, edge cases) get a 0
     * similarity penalty — they're effectively ranked by relevance only,
     * which is the safest fallback.
     */
    private selectByMMR;
    /**
     * toMemoryEntry — convert a Qdrant point payload to a contract MemoryEntry.
     * Tolerates legacy payloads that predate this store's schema.
     */
    private toMemoryEntry;
}
export {};
//# sourceMappingURL=QdrantSemanticStore.d.ts.map