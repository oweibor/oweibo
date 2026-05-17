"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.QdrantSemanticStore = exports.LegacySchemaError = exports.SchemaIncompatibleError = exports.SemanticStoreCapExceededError = void 0;
const node_crypto_1 = require("node:crypto");
const TenantKeyBuilder_js_1 = require("../../infra/TenantKeyBuilder.js");
const MemoryCircuitBreaker_js_1 = require("./MemoryCircuitBreaker.js");
const KeyedSerializer_js_1 = require("./KeyedSerializer.js");
const DEFAULT_KIND_BOOSTS = {
    'failure-lesson': 1.3,
    'success-pattern': 1.2,
    'architectural-decision': 1.2,
    'decision-rationale': 1.1,
    'tool-heuristic': 1.1,
    'code-landmark': 1.0,
    'domain-fact': 1.0,
    'open-question': 0.8,
};
const DEFAULT_CONFIG = {
    deduplicationThreshold: 0.93,
    maxEntriesPerTenant: 100_000,
    recencyHalfLifeDays: 14,
    weights: {
        semantic: 0.55,
        recency: 0.20,
        importance: 0.15,
        kindBoost: 0.10,
    },
    kindBoosts: DEFAULT_KIND_BOOSTS,
    overFetchMultiplier: 3,
    vectorDimension: 1536,
    mmrLambda: 0.7,
};
// ─── Errors ───────────────────────────────────────────────────────────────────
/**
 * Thrown by store() when the tenant's Qdrant collection has reached
 * config.maxEntriesPerTenant. Decay must run before new entries can be written.
 */
class SemanticStoreCapExceededError extends Error {
    constructor(tenantId, cap) {
        super(`Semantic store for tenant '${tenantId}' has reached the cap of ` +
            `${cap} entries. Run MemoryDecayService or purge stale entries.`);
        this.name = 'SemanticStoreCapExceededError';
    }
}
exports.SemanticStoreCapExceededError = SemanticStoreCapExceededError;
/**
 * Thrown when a tenant's existing Qdrant collection has a schema that's
 * incompatible with the current store config — typically the collection
 * was created with a different embedder dimension than this process is
 * configured to produce. Continuing would silently corrupt search results.
 */
class SchemaIncompatibleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SchemaIncompatibleError';
    }
}
exports.SchemaIncompatibleError = SchemaIncompatibleError;
/**
 * Thrown (in strict mode) when a collection exists but has no schema
 * marker — the entries predate this store's payload schema and recall
 * results will silently default missing fields. Set `strictSchema: false`
 * to downgrade this to a one-time warning during which the marker is
 * written and operation continues.
 */
class LegacySchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LegacySchemaError';
    }
}
exports.LegacySchemaError = LegacySchemaError;
// ─── Schema marker ────────────────────────────────────────────────────────────
/** Fixed UUID. The schema marker point is identical across every tenant. */
const SCHEMA_MARKER_ID = '00000000-0000-4000-8000-000000000001';
const SCHEMA_VERSION_V1 = 'v1';
const SOURCE_TAG = 'oweibo-qdrant-semantic-store/v1';
const DEFAULT_TOP_K = 6;
// ─── Kinds routed elsewhere ───────────────────────────────────────────────────
/**
 * These kinds are owned by other tiers. If the orchestrator routes them here
 * by mistake, store() throws loudly rather than silently mis-storing.
 */
const REJECTED_KINDS = new Set([
    'user-preference', // owned by UserProfileStore (Postgres)
    'project-invariant', // owned by ProjectRegistry (tier 3)
    'conversation-summary', // owned by ShortTermMemoryStore (tier 2)
]);
// ─── Store ────────────────────────────────────────────────────────────────────
class QdrantSemanticStore {
    deps;
    config;
    /**
     * Serialises the cap-check + upsert sequence per tenant within this
     * process. Closes gap #11 (TOCTOU): two concurrent stores for the same
     * tenant could each read points_count=cap-1 and both upsert, exceeding
     * the cap. Different tenants run concurrently as before.
     */
    writeSerializer = new KeyedSerializer_js_1.KeyedSerializer();
    /**
     * Serialises retrieve+setPayload per point. Closes gap #12: concurrent
     * recalls of the same point would each read recall_count=N and both
     * setPayload(N+1), losing one increment.
     */
    reinforceSerializer = new KeyedSerializer_js_1.KeyedSerializer();
    constructor(deps) {
        this.deps = deps;
        this.config = { ...DEFAULT_CONFIG, ...deps.config };
    }
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
    async store(input) {
        const { scope, kind, summary } = input;
        if (!scope.tenantId)
            throw new Error('QdrantSemanticStore.store: scope.tenantId is required');
        // 1. Kind guard
        if (REJECTED_KINDS.has(kind)) {
            throw new Error(`QdrantSemanticStore: kind '${kind}' must not be stored in the semantic tier. ` +
                `Route via MemoryOrchestrator.record() so it lands in its proper home.`);
        }
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(scope.tenantId);
        // 2. Ensure collection exists (creates on first store for a new tenant)
        await this.ensureCollection(collection);
        // 3. Embed (outside the per-tenant lock — slow, parallelisable)
        const vector = await this.deps.embedder(summary);
        // 4. Dedup — search for near-identical entry in same tenant. Racy by
        // design: two near-simultaneous stores of identical content may both
        // miss; that's acceptable because the dedup threshold is already a
        // best-effort similarity gate, not a uniqueness invariant.
        const filter = {
            must: [{ key: 'tenant_id', match: { value: scope.tenantId } }],
        };
        const duplicates = await this.qcall(() => this.deps.qdrant.search(collection, {
            vector,
            limit: 1,
            with_payload: false,
            score_threshold: this.config.deduplicationThreshold,
            filter,
        }));
        if (duplicates.length > 0 && duplicates[0] !== undefined) {
            // Reinforce existing entry instead of creating a duplicate, then return
            // its actual stored data (real recallCount, real timestamps).
            const existingId = String(duplicates[0].id);
            await this.reinforcePoint(collection, existingId);
            const [existing] = await this.qcall(() => this.deps.qdrant.retrieve(collection, {
                ids: [existingId], with_payload: true,
            }));
            if (existing)
                return this.toMemoryEntry(existing.id, existing.payload, scope.tenantId);
            // Fallback: collection mutated between dedup and retrieve (extremely rare)
            const now = new Date().toISOString();
            return {
                id: existingId, scope, kind, summary,
                body: input.body, detail: input.detail,
                importance: input.importance,
                createdAt: now, updatedAt: now, recallCount: 0,
                tags: input.tags ?? [],
            };
        }
        // 5. Cap check + upsert — serialised per tenant within this process so
        // the read-modify-write of points_count is atomic. Two concurrent
        // stores for the same tenant can no longer both pass a cap check at
        // points_count=cap-1 and then both upsert past the cap.
        return this.writeSerializer.chain(scope.tenantId, async () => {
            const { points_count } = await this.qcall(() => this.deps.qdrant.getCollection(collection));
            if ((points_count ?? 0) >= this.config.maxEntriesPerTenant) {
                throw new SemanticStoreCapExceededError(scope.tenantId, this.config.maxEntriesPerTenant);
            }
            const id = (0, node_crypto_1.randomUUID)();
            const now = new Date().toISOString();
            const payload = {
                tenant_id: scope.tenantId,
                user_id: scope.userId,
                project_id: scope.projectId,
                session_id: scope.sessionId,
                task_id: scope.taskId,
                kind,
                summary,
                body: input.body,
                detail: input.detail ?? null,
                importance: input.importance,
                created_at: now,
                updated_at: now,
                recall_count: 0,
                tags: input.tags ? [...input.tags] : [],
                _source: SOURCE_TAG,
            };
            await this.qcall(() => this.deps.qdrant.upsert(collection, {
                wait: true,
                points: [{ id, vector, payload }],
            }));
            return {
                id, scope, kind, summary,
                body: input.body,
                detail: input.detail,
                importance: input.importance,
                createdAt: now,
                updatedAt: now,
                recallCount: 0,
                tags: input.tags ?? [],
            };
        });
    }
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
    async recall(query) {
        const { tenantId, query: q, projectId, kinds, topK = DEFAULT_TOP_K, reinforce = false, } = query;
        if (!tenantId)
            throw new Error('QdrantSemanticStore.recall: tenantId is required');
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        const queryVector = await this.deps.embedder(q);
        // Build Qdrant filter
        const must = [{ key: 'tenant_id', match: { value: tenantId } }];
        if (projectId)
            must.push({ key: 'project_id', match: { value: projectId } });
        if (kinds?.length)
            must.push({ key: 'kind', match: { any: kinds } });
        // Over-fetch for re-ranking headroom
        const fetchLimit = topK * this.config.overFetchMultiplier;
        const mmrEnabled = this.config.mmrLambda < 1;
        let raw;
        try {
            raw = await this.qcall(() => this.deps.qdrant.search(collection, {
                vector: queryVector,
                limit: fetchLimit,
                with_payload: true,
                // Only request vectors when MMR will use them; saves bandwidth on
                // pure-relevance configurations.
                with_vector: mmrEnabled,
                filter: { must },
            }));
        }
        catch (err) {
            // Circuit-open is a system-wide signal callers must observe; rethrow.
            if (err instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                throw err;
            // Otherwise the collection probably doesn't exist yet — degrade gracefully.
            return [];
        }
        const now = Date.now();
        const w = this.config.weights;
        const candidates = raw.map((r) => {
            const payload = r.payload;
            const entry = this.toMemoryEntry(r.id, payload, tenantId);
            const breakdown = this.computeBreakdown(r.score, payload, entry.kind, now);
            const relevance = w.semantic * breakdown.semantic +
                w.recency * breakdown.recency +
                w.importance * breakdown.importance +
                w.kindBoost * breakdown.kindBoost;
            const vector = Array.isArray(r.vector) ? r.vector : undefined;
            return { entry, breakdown, relevance, ...(vector ? { vector } : {}) };
        });
        const selected = mmrEnabled
            ? this.selectByMMR(candidates, topK)
            : candidates.sort((a, b) => b.relevance - a.relevance).slice(0, topK);
        const results = selected.map(c => ({
            ...c.entry,
            score: c.relevance + c.breakdown.mmrPenalty,
            scoreBreakdown: c.breakdown,
        }));
        // Fire-and-forget reinforcement
        if (reinforce && results.length > 0) {
            void Promise.all(results.map((r) => this.reinforcePoint(collection, r.id))).catch(() => { });
        }
        return results;
    }
    /**
     * purgeTenant — hard delete all memories for a tenant.
     * Filters by tenant_id across the tenant's collection.
     */
    async purgeTenant(tenantId) {
        if (!tenantId)
            throw new Error('QdrantSemanticStore.purgeTenant: tenantId is required');
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        try {
            await this.qcall(() => this.deps.qdrant.delete(collection, {
                wait: true,
                filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
            }));
        }
        catch (err) {
            // Circuit open means the delete did NOT happen — must propagate, never audit.
            if (err instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                throw err;
            // Collection may not exist — that's fine for purge.
        }
        await this.fireAudit({ action: 'memory.tenant.purge', tenantId, ts: new Date() });
    }
    /**
     * purgeProject — hard delete all memories scoped to a specific project
     * without affecting the rest of the tenant's data.
     */
    async purgeProject(tenantId, projectId) {
        if (!tenantId)
            throw new Error('QdrantSemanticStore.purgeProject: tenantId is required');
        if (!projectId)
            throw new Error('QdrantSemanticStore.purgeProject: projectId is required');
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        try {
            await this.qcall(() => this.deps.qdrant.delete(collection, {
                wait: true,
                filter: {
                    must: [
                        { key: 'tenant_id', match: { value: tenantId } },
                        { key: 'project_id', match: { value: projectId } },
                    ],
                },
            }));
        }
        catch (err) {
            if (err instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                throw err;
            // Collection may not exist — that's fine for purge.
        }
        await this.fireAudit({ action: 'memory.project.purge', tenantId, projectId, ts: new Date() });
    }
    /**
     * purgeUser — hard delete all memories authored by a single user inside a
     * tenant. Used for per-user GDPR erasure when the user shares the tenant
     * with other members. Memories without a user_id (legacy or system-authored)
     * are left untouched.
     */
    async purgeUser(tenantId, userId) {
        if (!tenantId)
            throw new Error('QdrantSemanticStore.purgeUser: tenantId is required');
        if (!userId)
            throw new Error('QdrantSemanticStore.purgeUser: userId is required');
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        try {
            await this.qcall(() => this.deps.qdrant.delete(collection, {
                wait: true,
                filter: {
                    must: [
                        { key: 'tenant_id', match: { value: tenantId } },
                        { key: 'user_id', match: { value: userId } },
                    ],
                },
            }));
        }
        catch (err) {
            if (err instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                throw err;
            // Collection may not exist — that's fine for purge.
        }
        await this.fireAudit({ action: 'memory.user.purge', tenantId, userId, ts: new Date() });
    }
    // ── Private helpers ─────────────────────────────────────────────────────────
    /**
     * qcall — run a Qdrant client call through the optional circuit breaker.
     * Without a breaker this is a transparent passthrough. With a breaker,
     * sustained failures trip it and subsequent calls fast-fail with
     * MemoryCircuitOpenError until the cooldown elapses.
     */
    async qcall(fn) {
        if (!this.deps.breaker)
            return fn();
        return this.deps.breaker.exec(fn);
    }
    /**
     * fireAudit — invoke the optional purge auditor without letting its
     * failures undo the destructive operation. Must be called only AFTER the
     * underlying delete has succeeded.
     */
    async fireAudit(event) {
        if (!this.deps.audit)
            return;
        try {
            await this.deps.audit(event);
        }
        catch (err) {
            // Best-effort: audit must never undo a purge that already completed.
            console.warn('[QdrantSemanticStore] purge audit hook threw:', err);
        }
    }
    /**
     * ensureCollection — create the tenant's Qdrant collection if it doesn't
     * exist yet. Idempotent: swallows "already exists" errors from Qdrant.
     * Called at the top of store() so the first write for a new tenant
     * auto-provisions the collection rather than crashing with a 404.
     */
    async ensureCollection(collection) {
        let exists = true;
        try {
            await this.qcall(() => this.deps.qdrant.getCollection(collection));
        }
        catch (err) {
            if (err instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                throw err;
            exists = false;
        }
        if (!exists) {
            // Create the collection with cosine vectors of the configured dim,
            // then write the schema marker so future ensureCollection calls
            // can validate compatibility instead of guessing.
            try {
                await this.qcall(() => this.deps.qdrant.createCollection(collection, {
                    vectors: { size: this.config.vectorDimension, distance: 'Cosine' },
                }));
            }
            catch (createErr) {
                if (createErr instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                    throw createErr;
                // Race condition: another process created it between check and
                // create. The schema marker we're about to write may already
                // exist; writeSchemaMarker is idempotent (same fixed UUID).
            }
            await this.writeSchemaMarker(collection);
            return;
        }
        // Existing collection: validate the schema marker.
        const marker = await this.readSchemaMarker(collection);
        if (!marker) {
            // No marker → legacy collection (created before schema versioning).
            // Strict mode rejects writes that would extend the pollution; default
            // mode warns once, writes a marker so we don't keep warning, and
            // proceeds. Reads continue to tolerate missing fields via
            // toMemoryEntry's defaults.
            if (this.config.strictSchema) {
                throw new LegacySchemaError(`Qdrant collection '${collection}' has no schema marker — likely ` +
                    `holds legacy payloads. Migrate or purge before enabling strict mode.`);
            }
            console.warn(`[QdrantSemanticStore] collection '${collection}' has no schema marker; ` +
                `treating as legacy and writing a v1 marker. Recall results may include ` +
                `entries with default-valued kind/importance until the legacy entries are purged.`);
            await this.writeSchemaMarker(collection);
            return;
        }
        if (marker.vector_dim !== this.config.vectorDimension) {
            throw new SchemaIncompatibleError(`Qdrant collection '${collection}' was created with vector_dim=${marker.vector_dim}; ` +
                `current embedder produces vectors of dim=${this.config.vectorDimension}. ` +
                `Embedder swap detected. Purge the tenant and re-create with the correct ` +
                `embedder, or switch back to the original embedder.`);
        }
        if (this.config.embedderId && marker.embedder_id && marker.embedder_id !== this.config.embedderId) {
            throw new SchemaIncompatibleError(`Qdrant collection '${collection}' was created with embedder_id='${marker.embedder_id}'; ` +
                `current is '${this.config.embedderId}'. Embeddings produced by different models are ` +
                `not interchangeable even when their dimensions match.`);
        }
    }
    /**
     * readSchemaMarker — fetch the per-collection schema marker payload.
     * Returns null when the marker point is absent (legacy collection or
     * fresh creation in progress).
     */
    async readSchemaMarker(collection) {
        try {
            const points = await this.qcall(() => this.deps.qdrant.retrieve(collection, {
                ids: [SCHEMA_MARKER_ID], with_payload: true,
            }));
            const p = points[0];
            if (!p || !p.payload || p.payload._kind !== 'schema_marker')
                return null;
            const { version, vector_dim, created_at, embedder_id } = p.payload;
            if (typeof version !== 'string' || typeof vector_dim !== 'number' || typeof created_at !== 'string') {
                return null;
            }
            return {
                _kind: 'schema_marker',
                version,
                vector_dim,
                created_at,
                ...(embedder_id ? { embedder_id } : {}),
                _source: SOURCE_TAG,
            };
        }
        catch (err) {
            if (err instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                throw err;
            return null;
        }
    }
    /**
     * writeSchemaMarker — upsert the per-collection schema marker. Idempotent:
     * uses the fixed SCHEMA_MARKER_ID so repeated calls overwrite in place.
     * The marker carries no `tenant_id`, so recall (which filters by tenant_id)
     * never surfaces it as a result, and purge* won't delete it.
     */
    async writeSchemaMarker(collection) {
        const dim = this.config.vectorDimension;
        // A unit vector along the first axis — non-zero (cosine-safe), deterministic,
        // and far enough from real embedded text that it won't dedup-collide.
        const vector = Array(dim).fill(0);
        vector[0] = 1;
        const payload = {
            _kind: 'schema_marker',
            version: SCHEMA_VERSION_V1,
            vector_dim: dim,
            ...(this.config.embedderId ? { embedder_id: this.config.embedderId } : {}),
            created_at: new Date().toISOString(),
            _source: SOURCE_TAG,
        };
        try {
            await this.qcall(() => this.deps.qdrant.upsert(collection, {
                wait: true,
                points: [{ id: SCHEMA_MARKER_ID, vector, payload }],
            }));
        }
        catch (err) {
            if (err instanceof MemoryCircuitBreaker_js_1.MemoryCircuitOpenError)
                throw err;
            // Best-effort: marker is a hint, not a correctness requirement. Next
            // ensureCollection will re-attempt.
        }
    }
    /**
     * reinforcePoint — increment recall_count and bump updated_at.
     * Fire-and-forget; never throws to the caller.
     */
    async reinforcePoint(collection, pointId) {
        // Serialise per pointId so concurrent recalls of the same point don't
        // race the read-modify-write and lose increments. Serialiser key is
        // collection-prefixed because pointIds are not globally unique across
        // tenants — two tenants might happen to mint the same UUID and we
        // don't want their reinforcements queued behind each other.
        const lockKey = `${collection}::${pointId}`;
        return this.reinforceSerializer.chain(lockKey, async () => {
            try {
                const [point] = await this.qcall(() => this.deps.qdrant.retrieve(collection, {
                    ids: [pointId], with_payload: true,
                }));
                if (!point)
                    return;
                const currentCount = point.payload.recall_count ?? 0;
                await this.qcall(() => this.deps.qdrant.setPayload(collection, {
                    payload: {
                        recall_count: currentCount + 1,
                        updated_at: new Date().toISOString(),
                    },
                    points: [pointId],
                }));
            }
            catch {
                // Best-effort — stale recall_count is minor; if the breaker is open
                // here, the next store/recall will surface it to callers.
            }
        });
    }
    /**
     * computeBreakdown — calculate individual score components for auditability.
     * `mmrPenalty` is initialised to 0 here and overwritten by selectByMMR
     * for results that survive into the final selection.
     */
    computeBreakdown(cosineScore, payload, kind, nowMs) {
        // Recency: exponential decay based on days since last update
        const updatedAtStr = payload.updated_at ?? payload.created_at;
        const updatedAtMs = updatedAtStr ? new Date(updatedAtStr).getTime() : nowMs;
        const daysSince = Math.max(0, (nowMs - updatedAtMs) / 86_400_000);
        const recency = Math.exp(-daysSince / this.config.recencyHalfLifeDays);
        // Importance: directly from the stored value
        const importance = payload.importance ?? 0.5;
        // Kind boost: per-kind multiplier, defaulting to 1.0
        const kindBoost = this.config.kindBoosts[kind] ?? 1.0;
        return {
            semantic: cosineScore,
            recency,
            importance,
            kindBoost,
            mmrPenalty: 0,
        };
    }
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
    selectByMMR(candidates, topK) {
        const lambda = this.config.mmrLambda;
        const remaining = [...candidates];
        const selected = [];
        while (selected.length < topK && remaining.length > 0) {
            let bestIdx = 0;
            let bestScore = -Infinity;
            let bestPenalty = 0;
            for (let i = 0; i < remaining.length; i++) {
                const c = remaining[i];
                let maxSim = 0;
                if (c.vector) {
                    for (const s of selected) {
                        if (!s.vector)
                            continue;
                        const sim = cosineSimilarity(c.vector, s.vector);
                        if (sim > maxSim)
                            maxSim = sim;
                    }
                }
                const penalty = (1 - lambda) * maxSim; // ≥ 0
                const mmr = lambda * c.relevance - penalty;
                if (mmr > bestScore) {
                    bestScore = mmr;
                    bestIdx = i;
                    bestPenalty = penalty;
                }
            }
            const chosen = remaining.splice(bestIdx, 1)[0];
            // Record the penalty that was applied. Stored as a non-positive number
            // so callers can read "score = relevance + mmrPenalty" coherently.
            // Avoid signed-zero (-0): bestPenalty=0 → store +0, not -0.
            chosen.breakdown.mmrPenalty = bestPenalty === 0 ? 0 : -bestPenalty;
            selected.push(chosen);
        }
        return selected;
    }
    /**
     * toMemoryEntry — convert a Qdrant point payload to a contract MemoryEntry.
     * Tolerates legacy payloads that predate this store's schema.
     */
    toMemoryEntry(pointId, payload, tenantId) {
        const scope = {
            tenantId,
            userId: payload.user_id,
            projectId: payload.project_id,
            sessionId: payload.session_id,
            taskId: payload.task_id,
        };
        // Recover kind from payload; fall back to 'domain-fact' for legacy entries
        const kind = payload.kind ?? 'domain-fact';
        const summary = payload.summary ?? '';
        const body = payload.body;
        const detail = payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)
            ? payload.detail
            : undefined;
        const createdAt = payload.created_at ?? new Date().toISOString();
        const updatedAt = payload.updated_at ?? createdAt;
        return {
            id: String(pointId),
            scope,
            kind,
            summary,
            body,
            detail,
            importance: payload.importance ?? 0.5,
            createdAt,
            updatedAt,
            recallCount: payload.recall_count ?? 0,
            tags: Array.isArray(payload.tags) ? payload.tags : [],
        };
    }
}
exports.QdrantSemanticStore = QdrantSemanticStore;
// ─── Module-private helpers ───────────────────────────────────────────────────
/**
 * Cosine similarity between two equal-length vectors. Returns a value in
 * [-1, 1]; for normalised text-embedding vectors this is effectively in
 * [0, 1]. Returns 0 if either vector is the zero vector or if lengths
 * differ (defensive — should never happen with a single embedder).
 */
function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        const bi = b[i];
        dot += ai * bi;
        na += ai * ai;
        nb += bi * bi;
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
//# sourceMappingURL=QdrantSemanticStore.js.map