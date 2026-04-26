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

import { randomUUID } from 'crypto';
import type { Plan, DecisionLog } from '@oweibo/core-contracts';
import { TenantKeyBuilder } from '../infra/TenantKeyBuilder.js';
import { EmbeddingCache } from './EmbeddingCache.js';

// @qdrant/js-client-rest is an ESM-only package; under the project's Node16 CJS
// module mode a direct import triggers TS 1541. We use a local alias (established
// project pattern) until the package ships dual-mode types or the project migrates
// to ESM. Methods call qdrant via the concrete client at injection time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClient = any;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown by store() when the tenant's Qdrant collection has reached
 * config.maxLtmEntriesPerTenant. Decay must run before new entries can be written.
 */
export class LtmCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LtmCapExceededError';
  }
}

// ─── Memory Types ─────────────────────────────────────────────────────────────

export type MemoryType =
  | 'successful-strategy'
  | 'failure-pattern'
  | 'tool-heuristic'
  | 'domain-knowledge';
// NOTE: 'user-preference' is intentionally absent. User preferences are facts, not
// episodic observations. They do not belong in LTM (where they would decay, consume
// entry quota, and compete with task memories in vector recall). Preferences are owned
// exclusively by Postgres user_preferences table and loaded via UserProfileStore.

/**
 * MemoryTier — governs decay rate and consolidation eligibility.
 *
 *  episodic   — "what happened in task X"       — fast decay   (7-day  half-life)
 *  semantic   — "what we know is generally true" — slow decay   (90-day half-life)
 *  procedural — "how to do X reliably"           — very slow    (180-day half-life)
 */
export type MemoryTier = 'episodic' | 'semantic' | 'procedural';

// ─── Core Interfaces ──────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  tenantId: string;           // mandatory — Qdrant collection discriminator
  userId?: string;            // optional — set for user-scoped memories (scope 'user:{userId}')
  projectId?: string;         // optional — set for project-scoped memories (scope 'project:{id}')
  scope: string;              // see scope conventions in module JSDoc above
  type: MemoryType;
  tier: MemoryTier;           // controls decay half-life
  summary: string;            // short semantic label — used as vector source
  detail: unknown;            // full structured content
  relevanceTags: string[];    // e.g. ['typescript', 'auth', 'multi-tenant']
  successCount: number;       // incremented by reinforce()
  missCount: number;          // incremented by penalise() — feeds decay score
  confidence: number;         // 0–1: successCount / (successCount + missCount + 1)
  createdAt: number;          // Unix ms
  lastAccessedAt: number;     // Unix ms
  lastReinforcedAt: number;   // Unix ms
  promotedToId?: string;      // set once promoted to prevent double-promotion
  consolidatedAt?: number;    // Unix ms — set by MemoryConsolidator to prevent reprocessing
}

/** Typed recall result — includes composite score for caller-side confidence gating. */
export interface RecallResult {
  entry: MemoryEntry;
  score: number;  // composite: α·cosine + β·recency_boost + γ·success_rate
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface LongTermMemoryConfig {
  /** Composite score weights — must sum to 1.0 */
  similarityWeight: number;             // default: 0.60
  recencyWeight: number;                // default: 0.25
  successWeight: number;                // default: 0.15
  recencyHalfLifeDays: number;          // default: 14
  deduplicationThreshold: number;       // default: 0.93
  promotionThreshold: number;           // default: 10 — overridden per-tenant via Vault
  decayEvictionThreshold: number;       // default: 0.05 — entries below this go to archive
  tierHalfLife: Record<MemoryTier, number>;
  enableGovernanceScan: boolean;        // default: true
  maxPointsPerCyclePerTenant: number;   // default: 2_000 — Qdrant scroll cap for decay
  batchSize: number;                    // default: 100 — Qdrant scroll page size
  interBatchDelayMs: number;            // default: 50 — back-pressure between batches
  maxConcurrentTenants: number;         // default: 10 — p-limit for background jobs

  /**
   * Hard LLM call budget for MemoryConsolidator per tenant per cycle.
   * Without this cap a tenant with many distinct relevanceTags fires one LLM call
   * per qualifying cluster — unbounded at scale. Clusters are sorted by size
   * (largest first) so the highest-value consolidations always run within the cap.
   * Overridable per-tenant via Vault: oweibo/tenants/{tenantId}/memory/consolidation
   * (alongside windowDays and minClusterSize).
   */
  maxClustersPerCyclePerTenant: number; // default: 20

  /**
   * Hot STM layer: number of most-recent turns kept in-process per (tenantId, sessionId).
   * Recall over this window is a linear cosine scan — zero external I/O beyond embedding.
   * Older turns are evicted from the hot layer (they remain in the warm Redis VSS layer).
   */
  stmHotWindowSize: number;             // default: 50

  /**
   * Warm STM layer: maximum total entries per session in the Redis VSS index.
   * Enforced via atomic INCR on a per-session counter key before each write.
   * StorageCapExceededError is thrown if exceeded; the counter key shares the
   * session TTL so it expires automatically when the session does.
   */
  maxStmEntriesPerSession: number;      // default: 500

  /**
   * Maximum LTM entries per tenant Qdrant collection.
   * Enforced at store() time: if the collection already holds this many points,
   * store() throws LtmCapExceededError instead of upserting. Decay runs nightly
   * and should keep collections well below this ceiling in normal operation;
   * the cap is a hard backstop against runaway episodic writes.
   */
  maxLtmEntriesPerTenant: number;       // default: 100_000

  /**
   * Maximum tokens allocated to the userProfile fixed prompt block.
   * UserProfileStore truncates the rendered profile to this limit before returning.
   * Kept deliberately small — a well-structured profile is 200–500 tokens.
   * This block is always injected and never competes with warmMemory for budget.
   */
  userProfileTokenCap: number;          // default: 600

  /**
   * PreferenceNudgeService config — controls session-end preference detection.
   * Per-tenant overridable via Vault at oweibo/tenants/{tenantId}/memory/nudge.
   */
  nudgeMinConfidence: number;           // default: 0.6 — minimum LLM confidence to write
  nudgeMaxTurns: number;                // default: 20  — max STM turns to review per session
}

export const DEFAULT_LTM_CONFIG: LongTermMemoryConfig = {
  similarityWeight:               0.60,
  recencyWeight:                  0.25,
  successWeight:                  0.15,
  recencyHalfLifeDays:            14,
  deduplicationThreshold:         0.93,
  promotionThreshold:             10,
  decayEvictionThreshold:         0.05,
  tierHalfLife:                   { episodic: 7, semantic: 90, procedural: 180 },
  enableGovernanceScan:           true,
  maxPointsPerCyclePerTenant:     2_000,
  batchSize:                      100,
  interBatchDelayMs:              50,
  maxConcurrentTenants:           10,
  maxClustersPerCyclePerTenant:   20,
  stmHotWindowSize:               50,
  maxStmEntriesPerSession:        500,
  maxLtmEntriesPerTenant:         100_000,
  userProfileTokenCap:            600,
  nudgeMinConfidence:             0.6,
  nudgeMaxTurns:                  20,
};

// ─── Store ────────────────────────────────────────────────────────────────────

/** Input shape for store() — server-assigned fields are derived internally. */
type NewMemoryEntry = Omit<MemoryEntry,
  'id' | 'successCount' | 'missCount' | 'confidence' |
  'createdAt' | 'lastAccessedAt' | 'lastReinforcedAt'
>;

export class LongTermMemoryStore {
  // ── Construction ───────────────────────────────────────────────────────────

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly embeddingCache: EmbeddingCache,
    private readonly config: LongTermMemoryConfig = DEFAULT_LTM_CONFIG,
  ) {}

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * embed — cache-aware embedding via EmbeddingCache.
   * Single call-site: all methods that need a vector go through here so cache
   * behaviour is centralised and the hot path is never duplicated.
   */
  private async embed(text: string): Promise<number[]> {
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
  async store(entry: NewMemoryEntry): Promise<string> {
    // ── 1. Scope invariant guard ─────────────────────────────────────────────
    // user:{userId} scope is reserved for episodic events, never preferences.
    // Preferences belong exclusively in Postgres via UserProfileStore.upsertPreference().
    // This check runs before any I/O so a mis-routed write fails fast with a clear message.
    if (
      entry.scope.startsWith('user:') &&
      (entry.detail as Record<string, unknown> | null | undefined)?.['isPreference'] === true
    ) {
      throw new Error(
        `Preferences must not be written to LTM. ` +
        `Use UserProfileStore.upsertPreference() to persist user preferences to Postgres. ` +
        `Scope '${entry.scope}' with isPreference=true is not permitted in LongTermMemoryStore.store().`
      );
    }

    const collection = TenantKeyBuilder.ltmCollection(entry.tenantId);

    // ── 2. Cap check ─────────────────────────────────────────────────────────
    // Enforced before embedding to avoid a wasted API call when the collection is full.
    // Decay runs nightly and keeps collections well below this ceiling in normal operation;
    // this is a hard backstop against runaway writes (looping agent, migration bug).
    const { points_count } = await this.qdrant.getCollection(collection) as { points_count?: number };
    if ((points_count ?? 0) >= this.config.maxLtmEntriesPerTenant) {
      throw new LtmCapExceededError(
        `LTM collection for tenant '${entry.tenantId}' has reached the cap of ` +
        `${this.config.maxLtmEntriesPerTenant} entries. ` +
        `Run MemoryDecayService or purge stale entries before writing new memories.`
      );
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
    }) as Array<{ id: string }>;

    if (duplicates.length > 0 && duplicates[0] !== undefined) {
      const existingId = String(duplicates[0].id);
      await this.reinforce(existingId, entry.tenantId);
      return existingId;
    }

    // ── 5. Upsert ─────────────────────────────────────────────────────────────
    const id  = randomUUID();
    const now = Date.now();
    const full: MemoryEntry = {
      ...entry,
      id,
      successCount:      0,
      missCount:         0,
      confidence:        0,
      createdAt:         now,
      lastAccessedAt:    now,
      lastReinforcedAt:  now,
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
  async reinforce(memoryId: string, tenantId: string): Promise<void> {
    const collection = TenantKeyBuilder.ltmCollection(tenantId);

    const [point] = await this.qdrant.retrieve(collection, {
      ids:          [memoryId],
      with_payload: true,
    }) as Array<{ id: string; payload: MemoryEntry } | undefined>;

    if (!point) return; // already deleted or never existed — silent no-op

    const entry          = point.payload;
    const newSuccessCount = entry.successCount + 1;
    // Laplace smoothing: avoids 0-denominator and gives new entries a conservative start
    const newConfidence  = newSuccessCount / (newSuccessCount + entry.missCount + 1);
    const now            = Date.now();

    await this.qdrant.setPayload(collection, {
      payload: {
        successCount:     newSuccessCount,
        confidence:       newConfidence,
        lastAccessedAt:   now,
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
  async penalise(memoryId: string, tenantId: string): Promise<void> {
    const collection = TenantKeyBuilder.ltmCollection(tenantId);

    const [point] = await this.qdrant.retrieve(collection, {
      ids:          [memoryId],
      with_payload: true,
    }) as Array<{ id: string; payload: MemoryEntry } | undefined>;

    if (!point) return; // already deleted or never existed — silent no-op

    const entry        = point.payload;
    const newMissCount = entry.missCount + 1;
    // Laplace smoothing — same denominator structure as reinforce()
    const newConfidence = entry.successCount / (entry.successCount + newMissCount + 1);
    const now           = Date.now();

    await this.qdrant.setPayload(collection, {
      payload: {
        missCount:     newMissCount,
        confidence:    newConfidence,
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
  async recall(
    tenantId: string,
    query: string,
    options: {
      types?:    MemoryType[];
      tiers?:    MemoryTier[];
      scope?:    string;
      topK?:     number;
      minScore?: number;
    } = {},
  ): Promise<RecallResult[]> {
    const { types, tiers, scope, topK = 5, minScore = 0 } = options;
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    const vector     = await this.embed(query);

    // Build Qdrant filter — tenantId guard is always present for tenant isolation.
    const must: unknown[] = [{ key: 'tenantId', match: { value: tenantId } }];
    if (types?.length) must.push({ key: 'type',  match: { any: types } });
    if (tiers?.length) must.push({ key: 'tier',  match: { any: tiers } });
    if (scope)         must.push({ key: 'scope', match: { value: scope } });

    // Over-fetch so re-ranking can surface the best entries after composite scoring.
    // The raw Qdrant score is pure cosine; composite scoring re-orders the set.
    const raw = await this.qdrant.search(collection, {
      vector,
      limit:        topK * 3,
      with_payload: true,
      filter:       { must },
    }) as Array<{ id: string | number; score: number; payload: unknown }>;

    const now = Date.now();

    const results: RecallResult[] = raw
      .map(r => {
        const entry          = r.payload as MemoryEntry;
        const daysSinceAccess = (now - entry.lastAccessedAt) / 86_400_000;

        // Composite score — all weights from config, never hardcoded.
        const recencyBoost = Math.exp(-daysSinceAccess / this.config.recencyHalfLifeDays);
        const score =
          this.config.similarityWeight * r.score          // cosine similarity
          + this.config.recencyWeight   * recencyBoost    // exponential recency decay
          + this.config.successWeight   * entry.confidence; // Laplace-smoothed success rate

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
      void Promise.all(
        results.map(r =>
          this.qdrant.setPayload(collection, {
            payload: { lastAccessedAt: now },
            points:  [r.entry.id],
          }),
        ),
      ).catch(() => { /* best-effort — non-fatal */ });
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
  async consolidateFromTask(
    plan:        Plan,
    decisionLog: DecisionLog[],
    tenantId:    string,
  ): Promise<void> {
    const scope = `tenant:${tenantId}`;

    // Build all store() calls up-front so Promise.all fires them concurrently (G-M10).
    const writes: Promise<string>[] = [];

    // 1. Persist the winning strategy as tenant-wide semantic memory.
    writes.push(this.store({
      tenantId,
      scope,
      type:          'successful-strategy',
      tier:          'semantic',
      summary:       plan.strategy,
      detail:        {
        planId:          plan.id,
        feasibilityScore: plan.feasibilityScore,
        riskScore:        plan.riskScore,
        estimatedTokens:  plan.estimatedTokens,
        subGoalCount:     plan.subGoals.length,
        decisionCount:    decisionLog.length,
      },
      relevanceTags: ['strategy', 'plan'],
    }));

    // 2. Persist each non-trivial decision as a reusable tool-heuristic.
    //    Memory-recall decisions (stage === 'memory') are scaffolding, not heuristics.
    for (const d of decisionLog) {
      if (d.stage === 'memory') continue;
      writes.push(this.store({
        tenantId,
        scope,
        type:          'tool-heuristic',
        tier:          'episodic',
        summary:       `${d.decision}: ${d.rationale}`,
        detail:        {
          decisionId:    d.id,
          stage:         d.stage,
          requirementRef: d.requirementRef,
          alternatives:  d.alternatives,
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
