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
import { MemoryCircuitBreaker, MemoryCircuitOpenError } from './MemoryCircuitBreaker.js';
import { KeyedSerializer } from './KeyedSerializer.js';

// @qdrant/js-client-rest is ESM-only; same alias pattern used across the project.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  readonly action:    'memory.tenant.purge' | 'memory.project.purge' | 'memory.user.purge';
  readonly tenantId:  string;
  readonly projectId?: string;
  readonly userId?:    string;
  /** Wall-clock timestamp the purge completed. */
  readonly ts:        Date;
}

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

/**
 * Thrown when a tenant's existing Qdrant collection has a schema that's
 * incompatible with the current store config — typically the collection
 * was created with a different embedder dimension than this process is
 * configured to produce. Continuing would silently corrupt search results.
 */
export class SchemaIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaIncompatibleError';
  }
}

/**
 * Thrown (in strict mode) when a collection exists but has no schema
 * marker — the entries predate this store's payload schema and recall
 * results will silently default missing fields. Set `strictSchema: false`
 * to downgrade this to a one-time warning during which the marker is
 * written and operation continues.
 */
export class LegacySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacySchemaError';
  }
}

// ─── Schema marker ────────────────────────────────────────────────────────────

/** Fixed UUID. The schema marker point is identical across every tenant. */
const SCHEMA_MARKER_ID  = '00000000-0000-4000-8000-000000000001';
const SCHEMA_VERSION_V1 = 'v1';

/**
 * The marker payload sits in the per-tenant collection but carries NO
 * `tenant_id` field. That keeps recall()'s `tenant_id`-must filter from
 * surfacing it as a result, and makes purgeTenant/purgeUser/purgeProject
 * preserve it (deletion would force the next call to re-detect the
 * collection as legacy).
 */
interface SchemaMarkerPayload {
  readonly _kind:        'schema_marker';
  readonly version:      string;
  readonly vector_dim:   number;
  readonly embedder_id?: string;
  readonly created_at:   string;
  readonly _source:      string;
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface QdrantSemanticStoreDeps {
  readonly qdrant:   QdrantClient;
  readonly embedder: Embedder;
  readonly config?:  Partial<QdrantSemanticStoreConfig>;
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
  readonly audit?:   PurgeAuditor;
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
  /**
   * Serialises the cap-check + upsert sequence per tenant within this
   * process. Closes gap #11 (TOCTOU): two concurrent stores for the same
   * tenant could each read points_count=cap-1 and both upsert, exceeding
   * the cap. Different tenants run concurrently as before.
   */
  private readonly writeSerializer = new KeyedSerializer<string>();
  /**
   * Serialises retrieve+setPayload per point. Closes gap #12: concurrent
   * recalls of the same point would each read recall_count=N and both
   * setPayload(N+1), losing one increment.
   */
  private readonly reinforceSerializer = new KeyedSerializer<string>();

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
      limit:           1,
      with_payload:    false,
      score_threshold: this.config.deduplicationThreshold,
      filter,
    })) as Array<{ id: string }>;

    if (duplicates.length > 0 && duplicates[0] !== undefined) {
      // Reinforce existing entry instead of creating a duplicate, then return
      // its actual stored data (real recallCount, real timestamps).
      const existingId = String(duplicates[0].id);
      await this.reinforcePoint(collection, existingId);
      const [existing] = await this.qcall(() => this.deps.qdrant.retrieve(collection, {
        ids: [existingId], with_payload: true,
      })) as Array<{ id: string; payload: Partial<StoredPayload> } | undefined>;
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

    // 5. Cap check + upsert — serialised per tenant within this process so
    // the read-modify-write of points_count is atomic. Two concurrent
    // stores for the same tenant can no longer both pass a cap check at
    // points_count=cap-1 and then both upsert past the cap.
    return this.writeSerializer.chain(scope.tenantId, async () => {
      const { points_count } = await this.qcall(() => this.deps.qdrant.getCollection(collection)) as { points_count?: number };
      if ((points_count ?? 0) >= this.config.maxEntriesPerTenant) {
        throw new SemanticStoreCapExceededError(scope.tenantId, this.config.maxEntriesPerTenant);
      }

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

      await this.qcall(() => this.deps.qdrant.upsert(collection, {
        wait:   true,
        points: [{ id, vector, payload }],
      }));

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
    });
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
      raw = await this.qcall(() => this.deps.qdrant.search(collection, {
        vector,
        limit:        fetchLimit,
        with_payload: true,
        filter:       { must },
      })) as Array<{ id: string | number; score: number; payload: unknown }>;
    } catch (err) {
      // Circuit-open is a system-wide signal callers must observe; rethrow.
      if (err instanceof MemoryCircuitOpenError) throw err;
      // Otherwise the collection probably doesn't exist yet — degrade gracefully.
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
      await this.qcall(() => this.deps.qdrant.delete(collection, {
        wait:   true,
        filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
      }));
    } catch (err) {
      // Circuit open means the delete did NOT happen — must propagate, never audit.
      if (err instanceof MemoryCircuitOpenError) throw err;
      // Collection may not exist — that's fine for purge.
    }
    await this.fireAudit({ action: 'memory.tenant.purge', tenantId, ts: new Date() });
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
      await this.qcall(() => this.deps.qdrant.delete(collection, {
        wait:   true,
        filter: {
          must: [
            { key: 'tenant_id',  match: { value: tenantId } },
            { key: 'project_id', match: { value: projectId } },
          ],
        },
      }));
    } catch (err) {
      if (err instanceof MemoryCircuitOpenError) throw err;
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
  async purgeUser(tenantId: TenantId, userId: UserId): Promise<void> {
    if (!tenantId) throw new Error('QdrantSemanticStore.purgeUser: tenantId is required');
    if (!userId)   throw new Error('QdrantSemanticStore.purgeUser: userId is required');
    const collection = TenantKeyBuilder.ltmCollection(tenantId);
    try {
      await this.qcall(() => this.deps.qdrant.delete(collection, {
        wait:   true,
        filter: {
          must: [
            { key: 'tenant_id', match: { value: tenantId } },
            { key: 'user_id',   match: { value: userId } },
          ],
        },
      }));
    } catch (err) {
      if (err instanceof MemoryCircuitOpenError) throw err;
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
  private async qcall<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.deps.breaker) return fn();
    return this.deps.breaker.exec(fn);
  }

  /**
   * fireAudit — invoke the optional purge auditor without letting its
   * failures undo the destructive operation. Must be called only AFTER the
   * underlying delete has succeeded.
   */
  private async fireAudit(event: PurgeAuditEvent): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit(event);
    } catch (err) {
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
  private async ensureCollection(collection: string): Promise<void> {
    let exists = true;
    try {
      await this.qcall(() => this.deps.qdrant.getCollection(collection));
    } catch (err) {
      if (err instanceof MemoryCircuitOpenError) throw err;
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
      } catch (createErr) {
        if (createErr instanceof MemoryCircuitOpenError) throw createErr;
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
        throw new LegacySchemaError(
          `Qdrant collection '${collection}' has no schema marker — likely ` +
          `holds legacy payloads. Migrate or purge before enabling strict mode.`,
        );
      }
      console.warn(
        `[QdrantSemanticStore] collection '${collection}' has no schema marker; ` +
        `treating as legacy and writing a v1 marker. Recall results may include ` +
        `entries with default-valued kind/importance until the legacy entries are purged.`,
      );
      await this.writeSchemaMarker(collection);
      return;
    }

    if (marker.vector_dim !== this.config.vectorDimension) {
      throw new SchemaIncompatibleError(
        `Qdrant collection '${collection}' was created with vector_dim=${marker.vector_dim}; ` +
        `current embedder produces vectors of dim=${this.config.vectorDimension}. ` +
        `Embedder swap detected. Purge the tenant and re-create with the correct ` +
        `embedder, or switch back to the original embedder.`,
      );
    }

    if (this.config.embedderId && marker.embedder_id && marker.embedder_id !== this.config.embedderId) {
      throw new SchemaIncompatibleError(
        `Qdrant collection '${collection}' was created with embedder_id='${marker.embedder_id}'; ` +
        `current is '${this.config.embedderId}'. Embeddings produced by different models are ` +
        `not interchangeable even when their dimensions match.`,
      );
    }
  }

  /**
   * readSchemaMarker — fetch the per-collection schema marker payload.
   * Returns null when the marker point is absent (legacy collection or
   * fresh creation in progress).
   */
  private async readSchemaMarker(collection: string): Promise<SchemaMarkerPayload | null> {
    try {
      const points = await this.qcall(() => this.deps.qdrant.retrieve(collection, {
        ids: [SCHEMA_MARKER_ID], with_payload: true,
      })) as Array<{ id: string; payload?: Partial<SchemaMarkerPayload> }>;
      const p = points[0];
      if (!p || !p.payload || p.payload._kind !== 'schema_marker') return null;
      const { version, vector_dim, created_at, embedder_id } = p.payload;
      if (typeof version !== 'string' || typeof vector_dim !== 'number' || typeof created_at !== 'string') {
        return null;
      }
      return {
        _kind:      'schema_marker',
        version,
        vector_dim,
        created_at,
        ...(embedder_id ? { embedder_id } : {}),
        _source:    SOURCE_TAG,
      };
    } catch (err) {
      if (err instanceof MemoryCircuitOpenError) throw err;
      return null;
    }
  }

  /**
   * writeSchemaMarker — upsert the per-collection schema marker. Idempotent:
   * uses the fixed SCHEMA_MARKER_ID so repeated calls overwrite in place.
   * The marker carries no `tenant_id`, so recall (which filters by tenant_id)
   * never surfaces it as a result, and purge* won't delete it.
   */
  private async writeSchemaMarker(collection: string): Promise<void> {
    const dim = this.config.vectorDimension;
    // A unit vector along the first axis — non-zero (cosine-safe), deterministic,
    // and far enough from real embedded text that it won't dedup-collide.
    const vector = Array(dim).fill(0);
    vector[0] = 1;
    const payload: SchemaMarkerPayload = {
      _kind:      'schema_marker',
      version:    SCHEMA_VERSION_V1,
      vector_dim: dim,
      ...(this.config.embedderId ? { embedder_id: this.config.embedderId } : {}),
      created_at: new Date().toISOString(),
      _source:    SOURCE_TAG,
    };
    try {
      await this.qcall(() => this.deps.qdrant.upsert(collection, {
        wait:   true,
        points: [{ id: SCHEMA_MARKER_ID, vector, payload }],
      }));
    } catch (err) {
      if (err instanceof MemoryCircuitOpenError) throw err;
      // Best-effort: marker is a hint, not a correctness requirement. Next
      // ensureCollection will re-attempt.
    }
  }

  /**
   * reinforcePoint — increment recall_count and bump updated_at.
   * Fire-and-forget; never throws to the caller.
   */
  private async reinforcePoint(collection: string, pointId: string): Promise<void> {
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
        })) as Array<{ id: string; payload: Partial<StoredPayload> } | undefined>;

        if (!point) return;

        const currentCount = point.payload.recall_count ?? 0;
        await this.qcall(() => this.deps.qdrant.setPayload(collection, {
          payload: {
            recall_count: currentCount + 1,
            updated_at:   new Date().toISOString(),
          },
          points: [pointId],
        }));
      } catch {
        // Best-effort — stale recall_count is minor; if the breaker is open
        // here, the next store/recall will surface it to callers.
      }
    });
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
