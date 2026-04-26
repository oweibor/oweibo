"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.LongTermMemoryStore = exports.DEFAULT_LTM_CONFIG = exports.LtmCapExceededError = void 0;
const crypto_1 = require("crypto");
const TenantKeyBuilder_js_1 = require("../infra/TenantKeyBuilder.js");
// ─── Errors ───────────────────────────────────────────────────────────────────
/**
 * Thrown by store() when the tenant's Qdrant collection has reached
 * config.maxLtmEntriesPerTenant. Decay must run before new entries can be written.
 */
class LtmCapExceededError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LtmCapExceededError';
    }
}
exports.LtmCapExceededError = LtmCapExceededError;
exports.DEFAULT_LTM_CONFIG = {
    similarityWeight: 0.60,
    recencyWeight: 0.25,
    successWeight: 0.15,
    recencyHalfLifeDays: 14,
    deduplicationThreshold: 0.93,
    promotionThreshold: 10,
    decayEvictionThreshold: 0.05,
    tierHalfLife: { episodic: 7, semantic: 90, procedural: 180 },
    enableGovernanceScan: true,
    maxPointsPerCyclePerTenant: 2_000,
    batchSize: 100,
    interBatchDelayMs: 50,
    maxConcurrentTenants: 10,
    maxClustersPerCyclePerTenant: 20,
    stmHotWindowSize: 50,
    maxStmEntriesPerSession: 500,
    maxLtmEntriesPerTenant: 100_000,
    userProfileTokenCap: 600,
    nudgeMinConfidence: 0.6,
    nudgeMaxTurns: 20,
};
class LongTermMemoryStore {
    qdrant;
    embeddingCache;
    config;
    // ── Construction ───────────────────────────────────────────────────────────
    constructor(qdrant, embeddingCache, config = exports.DEFAULT_LTM_CONFIG) {
        this.qdrant = qdrant;
        this.embeddingCache = embeddingCache;
        this.config = config;
    }
    // ── Private helpers ────────────────────────────────────────────────────────
    /**
     * embed — cache-aware embedding via EmbeddingCache.
     * Single call-site: all methods that need a vector go through here so cache
     * behaviour is centralised and the hot path is never duplicated.
     */
    async embed(text) {
        return this.embeddingCache.embed(text);
    }
    // ── Public API — store / reinforce ─────────────────────────────────────────
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
    async store(entry) {
        // ── 1. Scope invariant guard ─────────────────────────────────────────────
        // user:{userId} scope is reserved for episodic events, never preferences.
        // Preferences belong exclusively in Postgres via UserProfileStore.upsertPreference().
        // This check runs before any I/O so a mis-routed write fails fast with a clear message.
        if (entry.scope.startsWith('user:') &&
            entry.detail?.['isPreference'] === true) {
            throw new Error(`Preferences must not be written to LTM. ` +
                `Use UserProfileStore.upsertPreference() to persist user preferences to Postgres. ` +
                `Scope '${entry.scope}' with isPreference=true is not permitted in LongTermMemoryStore.store().`);
        }
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(entry.tenantId);
        // ── 2. Cap check ─────────────────────────────────────────────────────────
        // Enforced before embedding to avoid a wasted API call when the collection is full.
        // Decay runs nightly and keeps collections well below this ceiling in normal operation;
        // this is a hard backstop against runaway writes (looping agent, migration bug).
        const { points_count } = await this.qdrant.getCollection(collection);
        if ((points_count ?? 0) >= this.config.maxLtmEntriesPerTenant) {
            throw new LtmCapExceededError(`LTM collection for tenant '${entry.tenantId}' has reached the cap of ` +
                `${this.config.maxLtmEntriesPerTenant} entries. ` +
                `Run MemoryDecayService or purge stale entries before writing new memories.`);
        }
        // ── 3. Embed ─────────────────────────────────────────────────────────────
        // Single embed call — vector is reused for both the dedup search and the upsert.
        const vector = await this.embed(entry.summary);
        // ── 4. Dedup ─────────────────────────────────────────────────────────────
        // Near-identical entry in the same scope (cosine > deduplicationThreshold) →
        // reinforce the existing point instead of creating a duplicate. Caller receives
        // the existing id so they can track which entry accumulated the signal.
        const duplicates = await this.qdrant.search(collection, {
            vector,
            limit: 1,
            with_payload: false,
            score_threshold: this.config.deduplicationThreshold,
            filter: { must: [{ key: 'scope', match: { value: entry.scope } }] },
        });
        if (duplicates.length > 0 && duplicates[0] !== undefined) {
            const existingId = String(duplicates[0].id);
            await this.reinforce(existingId, entry.tenantId);
            return existingId;
        }
        // ── 5. Upsert ─────────────────────────────────────────────────────────────
        const id = (0, crypto_1.randomUUID)();
        const now = Date.now();
        const full = {
            ...entry,
            id,
            successCount: 0,
            missCount: 0,
            confidence: 0,
            createdAt: now,
            lastAccessedAt: now,
            lastReinforcedAt: now,
        };
        await this.qdrant.upsert(collection, {
            points: [{ id, vector, payload: full }],
        });
        return id;
    }
    /**
     * Reinforce — increment successCount and recompute confidence using Laplace smoothing.
     * Updates lastAccessedAt and lastReinforcedAt timestamps.
     * Uses qdrant.setPayload() only — no re-embedding (gap G-M4 fix).
     *
     * Note: cross-scope promotion (§8 MemoryScopePromoter) is wired in a later phase.
     */
    async reinforce(memoryId, tenantId) {
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        const [point] = await this.qdrant.retrieve(collection, {
            ids: [memoryId],
            with_payload: true,
        });
        if (!point)
            return; // already deleted or never existed — silent no-op
        const entry = point.payload;
        const newSuccessCount = entry.successCount + 1;
        // Laplace smoothing: avoids 0-denominator and gives new entries a conservative start
        const newConfidence = newSuccessCount / (newSuccessCount + entry.missCount + 1);
        const now = Date.now();
        await this.qdrant.setPayload(collection, {
            payload: {
                successCount: newSuccessCount,
                confidence: newConfidence,
                lastAccessedAt: now,
                lastReinforcedAt: now,
            },
            points: [memoryId],
        });
    }
    /**
     * Penalise — increment missCount (entry was recalled but did not help).
     * Reduces confidence, accelerating decay for consistently unhelpful memories.
     * Symmetric with reinforce(): qdrant.setPayload() only — no re-embedding.
     */
    async penalise(memoryId, tenantId) {
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        const [point] = await this.qdrant.retrieve(collection, {
            ids: [memoryId],
            with_payload: true,
        });
        if (!point)
            return; // already deleted or never existed — silent no-op
        const entry = point.payload;
        const newMissCount = entry.missCount + 1;
        // Laplace smoothing — same denominator structure as reinforce()
        const newConfidence = entry.successCount / (entry.successCount + newMissCount + 1);
        const now = Date.now();
        await this.qdrant.setPayload(collection, {
            payload: {
                missCount: newMissCount,
                confidence: newConfidence,
                lastAccessedAt: now,
            },
            points: [memoryId],
        });
    }
    // ── Public API — recall ────────────────────────────────────────────────────
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
    async recall(tenantId, query, options = {}) {
        const { types, tiers, scope, topK = 5, minScore = 0 } = options;
        const collection = TenantKeyBuilder_js_1.TenantKeyBuilder.ltmCollection(tenantId);
        const vector = await this.embed(query);
        // Build Qdrant filter — tenantId guard is always present for tenant isolation.
        const must = [{ key: 'tenantId', match: { value: tenantId } }];
        if (types?.length)
            must.push({ key: 'type', match: { any: types } });
        if (tiers?.length)
            must.push({ key: 'tier', match: { any: tiers } });
        if (scope)
            must.push({ key: 'scope', match: { value: scope } });
        // Over-fetch so re-ranking can surface the best entries after composite scoring.
        // The raw Qdrant score is pure cosine; composite scoring re-orders the set.
        const raw = await this.qdrant.search(collection, {
            vector,
            limit: topK * 3,
            with_payload: true,
            filter: { must },
        });
        const now = Date.now();
        const results = raw
            .map(r => {
            const entry = r.payload;
            const daysSinceAccess = (now - entry.lastAccessedAt) / 86_400_000;
            // Composite score — all weights from config, never hardcoded.
            const recencyBoost = Math.exp(-daysSinceAccess / this.config.recencyHalfLifeDays);
            const score = this.config.similarityWeight * r.score // cosine similarity
                + this.config.recencyWeight * recencyBoost // exponential recency decay
                + this.config.successWeight * entry.confidence; // Laplace-smoothed success rate
            return { entry, score };
        })
            .filter(r => r.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
        // R-14: update lastAccessedAt for every returned entry.
        // Fire-and-forget — access tracking must not block the return path.
        // Failures are silently swallowed: stale lastAccessedAt is a minor analytics
        // imprecision, not a correctness issue.
        if (results.length > 0) {
            void Promise.all(results.map(r => this.qdrant.setPayload(collection, {
                payload: { lastAccessedAt: now },
                points: [r.entry.id],
            }))).catch(() => { });
        }
        return results;
    }
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
    async consolidateFromTask(plan, decisionLog, tenantId) {
        const scope = `tenant:${tenantId}`;
        // Build all store() calls up-front so Promise.all fires them concurrently (G-M10).
        const writes = [];
        // 1. Persist the winning strategy as tenant-wide semantic memory.
        writes.push(this.store({
            tenantId,
            scope,
            type: 'successful-strategy',
            tier: 'semantic',
            summary: plan.strategy,
            detail: {
                planId: plan.id,
                feasibilityScore: plan.feasibilityScore,
                riskScore: plan.riskScore,
                estimatedTokens: plan.estimatedTokens,
                subGoalCount: plan.subGoals.length,
                decisionCount: decisionLog.length,
            },
            relevanceTags: ['strategy', 'plan'],
        }));
        // 2. Persist each non-trivial decision as a reusable tool-heuristic.
        //    Memory-recall decisions (stage === 'memory') are scaffolding, not heuristics.
        for (const d of decisionLog) {
            if (d.stage === 'memory')
                continue;
            writes.push(this.store({
                tenantId,
                scope,
                type: 'tool-heuristic',
                tier: 'episodic',
                summary: `${d.decision}: ${d.rationale}`,
                detail: {
                    decisionId: d.id,
                    stage: d.stage,
                    requirementRef: d.requirementRef,
                    alternatives: d.alternatives,
                    rejectedReasons: d.rejectedReasons,
                    ...(d.agentRole !== undefined ? { agentRole: d.agentRole } : {}),
                },
                relevanceTags: [d.stage, ...(d.agentRole ? [d.agentRole] : [])],
            }));
        }
        // Concurrent batch — failures in individual store() calls are allowed to propagate.
        await Promise.all(writes);
    }
}
exports.LongTermMemoryStore = LongTermMemoryStore;
//# sourceMappingURL=LongTermMemoryStore.js.map