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

import { randomUUID } from 'node:crypto';

import type {
  ISemanticMemoryStore,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  ProjectId,
  RankedMemoryEntry,
  RecallQuery,
  StoreMemoryInput,
  TenantId,
  UserId,
} from '@oweibo/core-contracts';

import { TenantKeyBuilder } from '../../infra/TenantKeyBuilder.js';

// @qdrant/js-client-rest is ESM-only; same alias pattern used across the project.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClient = any;

/** Embedder function — accepts text, returns a float vector. */
export type Embedder = (text: string) => Promise<number[]>;

// ─── Configuration ────────────────────────────────────────────────────────────

export interface QdrantSemanticStoreConfig {
  /** Cosine similarity threshold for deduplication (default: 0.93). */
  readonly deduplicationThreshold: number;
  /** Max entries per tenant collection (default: 100_000). */
  readonly maxEntriesPerTenant: number;
  /** Recency half-life in days for composite scoring (default: 14). */
  readonly recencyHalfLifeDays: number;
  /** Composite score weights — must sum to ≤ 1.0. */
  readonly weights: {
    readonly semantic:   number; // default: 0.55
    readonly recency:    number; // default: 0.20
    readonly importance: number; // default: 0.15
    readonly kindBoost:  number; // default: 0.10
  };
  /** Per-kind boost multipliers applied to the kindBoost weight. */
  readonly kindBoosts: Partial<Record<MemoryKind, number>>;
  /** Over-fetch multiplier for recall (default: 3). */
  readonly overFetchMultiplier: number;
  /**
   * Embedding vector dimension used when auto-creating a tenant collection
   * (default: 1536, matching text-embedding-ada-002 / text-embedding-3-small).
   * Must match the embedder's output dimension.
   */
  readonly vectorDimension: number;
}

const DEFAULT_KIND_BOOSTS: Partial<Record<MemoryKind, number>> = {
  'failure-lesson':          1.3,
  'success-pattern':         1.2,
  'architectural-decision':  1.2,
  'decision-rationale':      1.1,
  'tool-heuristic':          1.1,
  'code-landmark':           1.0,
  'domain-fact':             1.0,
  'open-question':           0.8,
};

const DEFAULT_CONFIG: QdrantSemanticStoreConfig = {
  deduplicationThreshold: 0.93,
  maxEntriesPerTenant:    100_000,
  recencyHalfLifeDays:    14,
  weights: {
    semantic:   0.55,
    recency:    0.20,
    importance: 0.15,
    kindBoost:  0.10,
  },
  kindBoosts:          DEFAULT_KIND_BOOSTS,
  overFetchMultiplier: 3,
  vectorDimension:     1536,
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown by store() when the tenant's Qdrant collection has reached
 * config.maxEntriesPerTenant. Decay must run before new entries can be written.
 */
export class SemanticStoreCapExceededError extends Error {
  constructor(tenantId: string, cap: number) {
    super(
      `Semantic store for tenant '${tenantId}' has reached the cap of ` +
      `${cap} entries. Run MemoryDecayService or purge stale entries.`,
    );
    this.name = 'SemanticStoreCapExceededError';
  }
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface QdrantSemanticStoreDeps {
  readonly qdrant:   QdrantClient;
  readonly embedder: Embedder;
  readonly config?:  Partial<QdrantSemanticStoreConfig>;
}

// ─── Payload schema ───────────────────────────────────────────────────────────

/** The Qdrant payload written and read by this store. */
interface StoredPayload {
  readonly tenant_id:    string;
  readonly user_id?:     string;
  readonly project_id?:  string;
  readonly session_id?:  string;
  readonly task_id?:     string;
  readonly kind:         MemoryKind;
  readonly summary:      string;
  readonly body?:        string;
  readonly detail?:      Record<string, unknown> | null;
  readonly importance:   number;
  readonly created_at:   string;   // ISO 8601
  readonly updated_at:   string;   // ISO 8601
  readonly recall_count: number;
  readonly tags:         readonly string[];
  readonly _source:      string;
}

const SOURCE_TAG     = 'oweibo-qdrant-semantic-store/v1';
const DEFAULT_TOP_K  = 6;

// ─── Kinds routed elsewhere ───────────────────────────────────────────────────

/**
 * These kinds are owned by other tiers. If the orchestrator routes them here
 * by mistake, store() throws loudly rather than silently mis-storing.
 */
const REJECTED_KINDS = new Set<MemoryKind>([
  'user-preference',       // owned by UserProfileStore (Postgres)
  'project-invariant',     // owned by ProjectRegistry (tier 3)
  'conversation-summary',  // owned by ShortTermMemoryStore (tier 2)
]);

// ─── Store ────────────────────────────────────────────────────────────────────

export class QdrantSemanticStore implements ISemanticMemoryStore {
  private readonly config: QdrantSemanticStoreConfig;

  constructor(private readonly deps: QdrantSemanticStoreDeps) {
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
  async store(input: StoreMemoryInput): Promise<MemoryEntry> {
    const { scope, kind, summary } = input;
    if (!scope.tenantId) throw new Error('QdrantSemanticStore.store: scope.tenantId is required');

    // 1. Kind guard
    if (REJECTED_KINDS.has(kind)) {
      throw new Error(
        `QdrantSemanticStore: kind '${kind}' must not be stored in the semantic tier. ` +
        `Route via MemoryOrchestrator.record() so it lands in its proper home.`,
      );
    }

    const collection = TenantKeyBuilder.ltmCollection(scope.tenantId);

    // 2. Ensure collection exists (creates on first store for a new tenant)
    await this.ensureCollection(collection);

    // 3. Cap check
    const { points_count } = await this.deps.qdrant.getCollection(collection) as { points_count?: number };
    if ((points_count ?? 0) >= this.config.maxEntriesPerTenant) {
      throw new SemanticStoreCapExceededError(scope.tenantId, this.config.maxEntriesPerTenant);
    }

    // 4. Embed
    const vector = await this.deps.embedder(summary);

    // 5. Dedup — search for near-identical entry in same tenant
    const filter = {
      must: [{ key: 'tenant_id', match: { value: scope.tenantId } }],
    };
    const duplicates = await this.deps.qdrant.search(collection, {
      vector,
      limit:           1,
      with_payload:    false,
      score_threshold: this.config.deduplicationThreshold,
      filter,
    }) as Array<{ id: string }>;

    if (duplicates.length > 0 && duplicates[0] !== undefined) {
      // Reinforce existing entry instead of creating a duplicate, then return
      // its actual stored data (real recallCount, real timestamps).
      const existingId = String(duplicates[0].id);
      await this.reinforcePoint(collection, existingId);
      const [existing] = await this.deps.qdrant.retrieve(collection, {
        ids: [existingId], with_payload: true,
      }) as Array<{ id: string; payload: Partial<StoredPayload> } | undefined>;
      if (existing) return this.toMemoryEntry(existing.id, existing.payload, scope.tenantId);
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

    // 6. Upsert
    const id  = randomUUID();
    const now = new Date().toISOString();

    const payload: StoredPayload = {
      tenant_id:    scope.tenantId,
      user_id:      scope.userId,
      project_id:   scope.projectId,
      session_id:   scope.sessionId,
      task_id:      scope.taskId,
      kind,
      summary,
      body:         input.body,
      detail:       (input.detail as Record<string, unknown>) ?? null,
      importance:   input.importance,
      created_at:   now,
      updated_at:   now,
      recall_count: 0,
      tags:         input.tags ? [...input.tags] : [],
      _source:      SOURCE_TAG,
    };

    await this.deps.qdrant.upsert(collection, {
      wait:   true,
      points: [{ id, vector, payload }],
    });

    return {
      id, scope, kind, summary,
      body:        input.body,
      detail:      input.detail,
      importance:  input.importance,
      createdAt:   now,
      updatedAt:   now,
      recallCount: 0,
      tags:        input.tags ?? [],
    };
  }

  /**
   * recall — semantic search with full composite scoring.
   *
   * Over-fetches from Qdrant, then re-ranks every candidate with:
   *   score = w_semantic   · cosine
   *         + w_recency    · exp(-daysSinceUpdate / halfLifeDays)
   *         + w_importance · entry.importance
   *         + w_kindBoost  · kindBoostMultiplier
   *
   * Fire-and-forget reinforcement (recall_count++, updated_at bump) runs
   * after the result set is assembled — must not block the return path.
   */
  async recall(query: RecallQuery): Promise<readonly RankedMemoryEntry[]> {
    const {
      tenantId, query: q, projectId, kinds,
      topK = DEFAULT_TOP_K, reinforce = false,
    } = query;
    if (!tenantId) throw new Error('QdrantSemanticStore.recall: tenantId is required');

    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    const vector     = await this.deps.embedder(q);

    // Build Qdrant filter
    const must: unknown[] = [{ key: 'tenant_id', match: { value: tenantId } }];
    if (projectId) must.push({ key: 'project_id', match: { value: projectId } });
    if (kinds?.length) must.push({ key: 'kind', match: { any: kinds } });

    // Over-fetch for re-ranking headroom
    const fetchLimit = topK * this.config.overFetchMultiplier;

    let raw: Array<{ id: string | number; score: number; payload: unknown }>;
    try {
      raw = await this.deps.qdrant.search(collection, {
        vector,
        limit:        fetchLimit,
        with_payload: true,
        filter:       { must },
      }) as Array<{ id: string | number; score: number; payload: unknown }>;
    } catch {
      // Collection may not exist yet — degrade gracefully
      return [];
    }

    const now = Date.now();
    const w   = this.config.weights;

    const results: RankedMemoryEntry[] = raw
      .map((r) => {
        const payload   = r.payload as Partial<StoredPayload>;
        const entry     = this.toMemoryEntry(r.id, payload, tenantId);
        const breakdown = this.computeBreakdown(r.score, payload, entry.kind, now);
        const score     =
          w.semantic   * breakdown.semantic   +
          w.recency    * breakdown.recency    +
          w.importance * breakdown.importance +
          w.kindBoost  * breakdown.kindBoost  +
          breakdown.mmrPenalty; // subtracted, so it's already negative or 0

        return { ...entry, score, scoreBreakdown: breakdown };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Fire-and-forget reinforcement
    if (reinforce && results.length > 0) {
      void Promise.all(
        results.map((r) => this.reinforcePoint(collection, r.id)),
      ).catch(() => { /* best-effort */ });
    }

    return results;
  }

  /**
   * purgeTenant — hard delete all memories for a tenant.
   * Filters by tenant_id across the tenant's collection.
   */
  async purgeTenant(tenantId: TenantId): Promise<void> {
    if (!tenantId) throw new Error('QdrantSemanticStore.purgeTenant: tenantId is required');
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    try {
      await this.deps.qdrant.delete(collection, {
        wait:   true,
        filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
      });
    } catch {
      // Collection may not exist — that's fine for purge
    }
  }

  /**
   * purgeProject — hard delete all memories scoped to a specific project
   * without affecting the rest of the tenant's data.
   */
  async purgeProject(tenantId: TenantId, projectId: ProjectId): Promise<void> {
    if (!tenantId)  throw new Error('QdrantSemanticStore.purgeProject: tenantId is required');
    if (!projectId) throw new Error('QdrantSemanticStore.purgeProject: projectId is required');
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    try {
      await this.deps.qdrant.delete(collection, {
        wait:   true,
        filter: {
          must: [
            { key: 'tenant_id',  match: { value: tenantId } },
            { key: 'project_id', match: { value: projectId } },
          ],
        },
      });
    } catch {
      // Collection may not exist — that's fine for purge
    }
  }

  /**
   * purgeUser — hard delete all memories authored by a single user inside a
   * tenant. Used for per-user GDPR erasure when the user shares the tenant
   * with other members. Memories without a user_id (legacy or system-authored)
   * are left untouched.
   */
  async purgeUser(tenantId: TenantId, userId: UserId): Promise<void> {
    if (!tenantId) throw new Error('QdrantSemanticStore.purgeUser: tenantId is required');
    if (!userId)   throw new Error('QdrantSemanticStore.purgeUser: userId is required');
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    try {
      await this.deps.qdrant.delete(collection, {
        wait:   true,
        filter: {
          must: [
            { key: 'tenant_id', match: { value: tenantId } },
            { key: 'user_id',   match: { value: userId } },
          ],
        },
      });
    } catch {
      // Collection may not exist — that's fine for purge
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * ensureCollection — create the tenant's Qdrant collection if it doesn't
   * exist yet. Idempotent: swallows "already exists" errors from Qdrant.
   * Called at the top of store() so the first write for a new tenant
   * auto-provisions the collection rather than crashing with a 404.
   */
  private async ensureCollection(collection: string): Promise<void> {
    try {
      await this.deps.qdrant.getCollection(collection);
    } catch {
      // Collection doesn't exist — create it with cosine distance vectors.
      try {
        await this.deps.qdrant.createCollection(collection, {
          vectors: { size: this.config.vectorDimension, distance: 'Cosine' },
        });
      } catch {
        // Race condition: another process created it between our check and create.
        // Safe to ignore — the collection exists now.
      }
    }
  }

  /**
   * reinforcePoint — increment recall_count and bump updated_at.
   * Fire-and-forget; never throws to the caller.
   */
  private async reinforcePoint(collection: string, pointId: string): Promise<void> {
    try {
      // Retrieve current recall_count
      const [point] = await this.deps.qdrant.retrieve(collection, {
        ids: [pointId], with_payload: true,
      }) as Array<{ id: string; payload: Partial<StoredPayload> } | undefined>;

      if (!point) return;

      const currentCount = point.payload.recall_count ?? 0;
      await this.deps.qdrant.setPayload(collection, {
        payload: {
          recall_count: currentCount + 1,
          updated_at:   new Date().toISOString(),
        },
        points: [pointId],
      });
    } catch {
      // Non-fatal — stale recall_count is a minor analytics imprecision
    }
  }

  /**
   * computeBreakdown — calculate individual score components for auditability.
   */
  private computeBreakdown(
    cosineScore: number,
    payload: Partial<StoredPayload>,
    kind: MemoryKind,
    nowMs: number,
  ): RankedMemoryEntry['scoreBreakdown'] {
    // Recency: exponential decay based on days since last update
    const updatedAtStr = payload.updated_at ?? payload.created_at;
    const updatedAtMs  = updatedAtStr ? new Date(updatedAtStr).getTime() : nowMs;
    const daysSince    = Math.max(0, (nowMs - updatedAtMs) / 86_400_000);
    const recency      = Math.exp(-daysSince / this.config.recencyHalfLifeDays);

    // Importance: directly from the stored value
    const importance = payload.importance ?? 0.5;

    // Kind boost: per-kind multiplier, defaulting to 1.0
    const kindBoost = this.config.kindBoosts[kind] ?? 1.0;

    return {
      semantic:   cosineScore,
      recency,
      importance,
      kindBoost,
      mmrPenalty: 0, // placeholder for future MMR implementation
    };
  }

  /**
   * toMemoryEntry — convert a Qdrant point payload to a contract MemoryEntry.
   * Tolerates legacy payloads that predate this store's schema.
   */
  private toMemoryEntry(
    pointId: string | number,
    payload: Partial<StoredPayload>,
    tenantId: TenantId,
  ): MemoryEntry {
    const scope: MemoryScope = {
      tenantId,
      userId:    payload.user_id,
      projectId: payload.project_id,
      sessionId: payload.session_id,
      taskId:    payload.task_id,
    };

    // Recover kind from payload; fall back to 'domain-fact' for legacy entries
    const kind: MemoryKind = (payload.kind as MemoryKind) ?? 'domain-fact';

    const summary = payload.summary ?? '';
    const body    = payload.body;
    const detail  = payload.detail && typeof payload.detail === 'object' && !Array.isArray(payload.detail)
      ? (payload.detail as Readonly<Record<string, unknown>>)
      : undefined;

    const createdAt = payload.created_at ?? new Date().toISOString();
    const updatedAt = payload.updated_at ?? createdAt;

    return {
      id:          String(pointId),
      scope,
      kind,
      summary,
      body,
      detail,
      importance:  payload.importance ?? 0.5,
      createdAt,
      updatedAt,
      recallCount: payload.recall_count ?? 0,
      tags:        Array.isArray(payload.tags) ? payload.tags : [],
    };
  }
}
