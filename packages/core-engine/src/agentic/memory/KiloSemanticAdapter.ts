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

// @qdrant/js-client-rest is ESM-only; under the project's CJS module mode
// a direct import triggers TS 1541 — same workaround the legacy
// LongTermMemoryStore uses. Methods call qdrant via the concrete client at
// injection time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QdrantClientLike = any;

export type Embedder = (text: string) => Promise<number[]>;

const COLLECTION_DECISIONS = 'project_decisions';
const COLLECTION_REASONING = 'project_reasoning';
const COLLECTION_HISTORY   = 'project_history';
const SOURCE_TAG           = 'oweibo-semantic-adapter/v1';
const DEFAULT_TOP_K        = 6;

type AdapterCollection =
  | typeof COLLECTION_DECISIONS
  | typeof COLLECTION_REASONING
  | typeof COLLECTION_HISTORY;

/**
 * Per-kind routing. Kinds the orchestrator owns elsewhere are 'reject' —
 * routing one of those here means the orchestrator has a routing bug, and
 * loud failure is preferable to silent mis-storage.
 */
const KIND_TO_COLLECTION: Record<MemoryKind, AdapterCollection | 'reject'> = {
  'architectural-decision': COLLECTION_DECISIONS,
  'decision-rationale':     COLLECTION_REASONING,
  'failure-lesson':         COLLECTION_HISTORY,
  'success-pattern':        COLLECTION_HISTORY,
  'code-landmark':          COLLECTION_HISTORY,
  'domain-fact':            COLLECTION_HISTORY,
  'open-question':          COLLECTION_HISTORY,
  'tool-heuristic':         COLLECTION_HISTORY,

  // Routed elsewhere by the orchestrator — adapter rejects on store.
  'project-invariant':      'reject', // owned by ProjectRegistry
  'conversation-summary':   'reject', // owned by STM rolling summary
  'user-preference':        'reject', // owned by UserProfileStore (Postgres)
};

/** Reverse fallback used only when the kind tag is missing on a recalled entry. */
const COLLECTION_FALLBACK_KIND: Record<AdapterCollection, MemoryKind> = {
  [COLLECTION_DECISIONS]: 'architectural-decision',
  [COLLECTION_REASONING]: 'decision-rationale',
  [COLLECTION_HISTORY]:   'success-pattern',
};

const ALL_COLLECTIONS: readonly AdapterCollection[] = [
  COLLECTION_DECISIONS, COLLECTION_REASONING, COLLECTION_HISTORY,
];

export interface KiloSemanticAdapterDeps {
  readonly qdrant:   QdrantClientLike;
  readonly embedder: Embedder;
}

interface QdrantPoint {
  readonly id:      string | number;
  readonly score?:  number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class KiloSemanticAdapter implements ISemanticMemoryStore {
  constructor(private readonly deps: KiloSemanticAdapterDeps) {}

  async store(input: StoreMemoryInput): Promise<MemoryEntry> {
    if (!input.scope.tenantId) {
      throw new Error('KiloSemanticAdapter.store: scope.tenantId is required');
    }
    const collection = KIND_TO_COLLECTION[input.kind];
    if (collection === 'reject') {
      throw new Error(
        `KiloSemanticAdapter: kind '${input.kind}' is not stored in kilo's ` +
        `semantic collections. Route via MemoryOrchestrator.record() so it ` +
        `lands in its proper home (ProjectRegistry / STM / UserProfileStore).`,
      );
    }

    const id  = randomUUID();
    const now = new Date().toISOString();
    const vector = await this.deps.embedder(input.summary);

    const payload = {
      tenant_id:    input.scope.tenantId,
      project_id:   input.scope.projectId,
      scope:        scopeLabel(input.scope),
      kind:         input.kind,
      summary:      input.summary,
      body:         input.body,
      detail:       input.detail ?? null,
      importance:   input.importance,
      created_at:   now,
      updated_at:   now,
      recall_count: 0,
      _source:      SOURCE_TAG,
    };

    await this.deps.qdrant.upsert(collection, {
      wait:   true,
      points: [{ id, vector, payload }],
    });

    return {
      id,
      scope:       input.scope,
      kind:        input.kind,
      summary:     input.summary,
      body:        input.body,
      detail:      input.detail,
      importance:  input.importance,
      createdAt:   now,
      updatedAt:   now,
      recallCount: 0,
    };
  }

  async recall(query: RecallQuery): Promise<readonly RankedMemoryEntry[]> {
    if (!query.tenantId) throw new Error('KiloSemanticAdapter.recall: tenantId is required');
    const { tenantId, query: q, projectId, kinds, topK = DEFAULT_TOP_K, reinforce = false } = query;

    const targets = collectionsFor(kinds);
    if (targets.length === 0) return [];

    const vector = await this.deps.embedder(q);
    const filter = buildFilter(tenantId, projectId, kinds);

    // Over-fetch per collection so the merged top-K isn't dominated by a single
    // collection just because it returned the requested limit first.
    const perCollectionLimit = Math.max(topK, Math.ceil(topK * 1.5));
    const responses = await Promise.allSettled(
      targets.map(async (collection): Promise<readonly { collection: AdapterCollection; point: QdrantPoint }[]> => {
        try {
          const points = await this.deps.qdrant.search(collection, {
            vector, limit: perCollectionLimit, with_payload: true, filter,
          }) as QdrantPoint[];
          return points.map((point) => ({ collection, point }));
        } catch {
          // A single collection failure must not poison the whole recall —
          // collections are created lazily and may not exist yet in fresh envs.
          return [];
        }
      }),
    );

    const merged: { collection: AdapterCollection; point: QdrantPoint }[] = [];
    for (const r of responses) if (r.status === 'fulfilled') merged.push(...r.value);

    merged.sort((a, b) => (b.point.score ?? 0) - (a.point.score ?? 0));
    const top = merged.slice(0, topK);

    if (reinforce && top.length > 0) {
      const now = new Date().toISOString();
      for (const { collection, point } of top) {
        const current = numberAt(point.payload, 'recall_count') ?? 0;
        // Fire-and-forget — reinforcement failures must not break recall.
        void this.deps.qdrant.setPayload(collection, {
          points:  [point.id],
          payload: { recall_count: current + 1, updated_at: now },
          wait:    false,
        }).catch(() => {});
      }
    }

    return top.map(({ collection, point }) => this.toRanked(collection, point, tenantId));
  }

  async purgeTenant(tenantId: TenantId): Promise<void> {
    if (!tenantId) throw new Error('KiloSemanticAdapter.purgeTenant: tenantId is required');
    const filter = { must: [{ key: 'tenant_id', match: { value: tenantId } }] };
    await Promise.all(
      ALL_COLLECTIONS.map((collection) =>
        // Allow per-collection failures (e.g. collection doesn't exist) to
        // surface so callers can decide; offboarding wants a hard error if
        // any tenant data remains.
        this.deps.qdrant.delete(collection, { wait: true, filter }),
      ),
    );
  }

  async purgeProject(tenantId: TenantId, projectId: ProjectId): Promise<void> {
    if (!tenantId)  throw new Error('KiloSemanticAdapter.purgeProject: tenantId is required');
    if (!projectId) throw new Error('KiloSemanticAdapter.purgeProject: projectId is required');
    const filter = {
      must: [
        { key: 'tenant_id', match: { value: tenantId } },
        { key: 'project_id', match: { value: projectId } },
      ],
    };
    await Promise.all(
      ALL_COLLECTIONS.map((collection) =>
        this.deps.qdrant.delete(collection, { wait: true, filter }),
      ),
    );
  }

  async purgeUser(tenantId: TenantId, userId: UserId): Promise<void> {
    if (!tenantId) throw new Error('KiloSemanticAdapter.purgeUser: tenantId is required');
    if (!userId)   throw new Error('KiloSemanticAdapter.purgeUser: userId is required');
    const filter = {
      must: [
        { key: 'tenant_id', match: { value: tenantId } },
        { key: 'user_id',   match: { value: userId } },
      ],
    };
    await Promise.all(
      ALL_COLLECTIONS.map((collection) =>
        this.deps.qdrant.delete(collection, { wait: true, filter }),
      ),
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private toRanked(
    collection: AdapterCollection,
    point: QdrantPoint,
    tenantId: TenantId,
  ): RankedMemoryEntry {
    const payload = point.payload;
    const kind = stringAt(payload, 'kind') as MemoryKind | undefined ?? COLLECTION_FALLBACK_KIND[collection];
    const projectId =
      stringAt(payload, 'project_id') ?? stringAt(payload, 'projectId');
    const scope: MemoryScope = { tenantId, projectId };

    const summary = stringAt(payload, 'summary')
      ?? stringAt(payload, 'title')      // legacy stage-output payloads
      ?? stringAt(payload, 'content')    // very old payloads
      ?? '';
    const body = stringAt(payload, 'body');
    const detail =
      payload['detail'] && typeof payload['detail'] === 'object' && !Array.isArray(payload['detail'])
        ? (payload['detail'] as Readonly<Record<string, unknown>>)
        : undefined;

    const importance =
      numberAt(payload, 'importance')
      ?? numberAt(payload, 'confidence')
      ?? (point.score ?? 0);

    const createdAt = stringAt(payload, 'created_at')
      ?? stringAt(payload, 'createdAt')
      ?? new Date().toISOString();
    const updatedAt = stringAt(payload, 'updated_at')
      ?? stringAt(payload, 'updatedAt')
      ?? createdAt;
    const recallCount = numberAt(payload, 'recall_count') ?? 0;

    const score = point.score ?? 0;
    return {
      id:          String(point.id),
      scope,
      kind,
      summary,
      body,
      detail,
      importance,
      createdAt,
      updatedAt,
      recallCount,
      score,
      // Adapter only knows the cosine score; report it in `semantic` and zero
      // the other channels so the breakdown sums to the composite.
      scoreBreakdown: {
        semantic:   score,
        recency:    0,
        importance: 0,
        kindBoost:  0,
        mmrPenalty: 0,
      },
    };
  }
}

// ── module-private utilities ────────────────────────────────────────────────

function scopeLabel(scope: MemoryScope): string | undefined {
  if (scope.taskId)    return `task:${scope.taskId}`;
  if (scope.projectId) return `project:${scope.projectId}`;
  if (scope.sessionId) return `session:${scope.sessionId}`;
  return undefined;
}

function collectionsFor(kinds: readonly MemoryKind[] | undefined): readonly AdapterCollection[] {
  if (!kinds || kinds.length === 0) return ALL_COLLECTIONS;
  const set = new Set<AdapterCollection>();
  for (const k of kinds) {
    const c = KIND_TO_COLLECTION[k];
    if (c !== 'reject') set.add(c);
  }
  return [...set];
}

function buildFilter(
  tenantId: TenantId,
  projectId: ProjectId | undefined,
  kinds: readonly MemoryKind[] | undefined,
): Readonly<Record<string, unknown>> {
  const must: unknown[] = [{ key: 'tenant_id', match: { value: tenantId } }];
  if (projectId) must.push({ key: 'project_id', match: { value: projectId } });
  if (kinds && kinds.length > 0) {
    const concrete = kinds.filter((k) => KIND_TO_COLLECTION[k] !== 'reject');
    if (concrete.length > 0) {
      must.push({ key: 'kind', match: { any: concrete } });
    }
  }
  return { must };
}

function stringAt(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' ? v : undefined;
}

function numberAt(payload: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
