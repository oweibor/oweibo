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
} from '@oweibo/core-contracts';

import type {
  LongTermMemoryStore,
  MemoryEntry as LtmEntry,
  MemoryTier as LtmTier,
  MemoryType as LtmType,
  RecallResult as LtmRecallResult,
} from '../LongTermMemoryStore.js';

const KIND_TAG_PREFIX = 'kind:';
const DEFAULT_TOP_K   = 6;

type LtmMapping = { type: LtmType; tier: LtmTier } | 'reject';

const KIND_TO_LTM: Record<MemoryKind, LtmMapping> = {
  // Routed elsewhere by the orchestrator — adapter rejects so the routing bug
  // is loud rather than silent.
  'user-preference':         'reject', // Postgres-owned per legacy LTM invariant
  'project-invariant':       'reject', // owned by ProjectRegistry
  'conversation-summary':    'reject', // owned by STM rolling summary

  'architectural-decision':  { type: 'domain-knowledge',    tier: 'semantic'   },
  'decision-rationale':      { type: 'domain-knowledge',    tier: 'semantic'   },
  'failure-lesson':          { type: 'failure-pattern',     tier: 'episodic'   },
  'success-pattern':         { type: 'successful-strategy', tier: 'procedural' },
  'code-landmark':           { type: 'domain-knowledge',    tier: 'semantic'   },
  'domain-fact':             { type: 'domain-knowledge',    tier: 'semantic'   },
  'open-question':           { type: 'domain-knowledge',    tier: 'episodic'   },
  'tool-heuristic':          { type: 'tool-heuristic',      tier: 'procedural' },
};

/** Reverse fallback used only when the kind tag is missing from a recalled entry. */
const LTM_TYPE_TO_KIND: Record<LtmType, MemoryKind> = {
  'successful-strategy': 'success-pattern',
  'failure-pattern':     'failure-lesson',
  'tool-heuristic':      'tool-heuristic',
  'domain-knowledge':    'domain-fact',
};

export class SemanticMemoryAdapter implements ISemanticMemoryStore {
  constructor(private readonly ltm: LongTermMemoryStore) {}

  async store(input: StoreMemoryInput): Promise<MemoryEntry> {
    const mapping = KIND_TO_LTM[input.kind];
    if (mapping === 'reject') {
      throw new Error(
        `SemanticMemoryAdapter: kind '${input.kind}' is not stored in the legacy LTM. ` +
        `Route via MemoryOrchestrator.record() so it lands in its proper home.`,
      );
    }
    if (!input.scope.tenantId) throw new Error('SemanticMemoryAdapter.store: scope.tenantId is required');

    const tags = [kindTag(input.kind), ...(pickStringArray(input.detail, 'tags') ?? [])];
    const ltmDetail =
      input.body !== undefined || input.detail !== undefined
        ? { body: input.body, ...(input.detail ?? {}) }
        : null;

    const id = await this.ltm.store({
      tenantId:      input.scope.tenantId,
      projectId:     input.scope.projectId,
      scope:         ltmScopeOf(input.scope),
      type:          mapping.type,
      tier:          mapping.tier,
      summary:       input.summary,
      detail:        ltmDetail,
      relevanceTags: tags,
    });

    const now = new Date().toISOString();
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
    const { tenantId, query: q, projectId, kinds, topK = DEFAULT_TOP_K, reinforce = false } = query;
    if (!tenantId) throw new Error('SemanticMemoryAdapter.recall: tenantId is required');

    // Map kinds → legacy types/tiers if the caller specified a kind filter.
    // Multiple kinds can map to the same (type, tier), so dedupe via Sets.
    let types: LtmType[] | undefined;
    let tiers: LtmTier[] | undefined;
    if (kinds?.length) {
      const typeSet = new Set<LtmType>();
      const tierSet = new Set<LtmTier>();
      for (const k of kinds) {
        const m = KIND_TO_LTM[k];
        if (m === 'reject') continue;
        typeSet.add(m.type);
        tierSet.add(m.tier);
      }
      // If every requested kind was 'reject' we'd produce empty sets — short-
      // circuit so we don't accidentally match all types/tiers via undefined.
      if (typeSet.size === 0) return [];
      types = [...typeSet];
      tiers = [...tierSet];
    }

    const scope = projectId ? `project:${projectId}` : undefined;
    const results = await this.ltm.recall(tenantId, q, { topK, types, tiers, scope });

    if (reinforce) {
      // Fire-and-forget reinforcement; failures here must not break recall.
      for (const r of results) {
        void this.ltm.reinforce(r.entry.id, tenantId).catch(() => {});
      }
    }

    return results.map((r) => this.toRanked(r, tenantId));
  }

  async purgeTenant(_tenantId: TenantId): Promise<void> {
    throw new Error(
      'SemanticMemoryAdapter.purgeTenant: not implemented. ' +
      'Use Qdrant collection-level tooling for tenant offboarding.',
    );
  }

  async purgeProject(_tenantId: TenantId, _projectId: ProjectId): Promise<void> {
    throw new Error(
      'SemanticMemoryAdapter.purgeProject: not implemented. ' +
      'Add a project-scope delete to LongTermMemoryStore before exposing this.',
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private toRanked(r: LtmRecallResult, tenantId: TenantId): RankedMemoryEntry {
    const e = r.entry;
    const kind = readKindFromTags(e.relevanceTags, LTM_TYPE_TO_KIND[e.type]);
    const scope: MemoryScope = {
      tenantId,
      projectId: e.projectId,
      // sessionId / taskId are not recoverable from the legacy single-string
      // scope; the contract accepts this — only tenantId is mandatory.
    };
    const detailObj =
      e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail)
        ? (e.detail as Readonly<Record<string, unknown>>)
        : undefined;
    const body =
      detailObj && typeof detailObj['body'] === 'string'
        ? (detailObj['body'] as string)
        : undefined;

    return {
      id:          e.id,
      scope,
      kind,
      summary:     e.summary,
      body,
      detail:      detailObj,
      importance:  e.confidence,
      createdAt:   new Date(e.createdAt).toISOString(),
      updatedAt:   new Date(e.lastReinforcedAt).toISOString(),
      recallCount: e.successCount,
      score:       r.score,
      scoreBreakdown: {
        semantic:   r.score,
        recency:    0,
        importance: 0,
        kindBoost:  0,
        mmrPenalty: 0,
      },
    };
  }
}

// ── module-private utilities ────────────────────────────────────────────────

function ltmScopeOf(scope: MemoryScope): string {
  if (scope.projectId) return `project:${scope.projectId}`;
  if (scope.taskId)    return `task:${scope.taskId}`;
  return `tenant:${scope.tenantId}`;
}

function kindTag(kind: MemoryKind): string {
  return `${KIND_TAG_PREFIX}${kind}`;
}

function readKindFromTags(tags: readonly string[], fallback: MemoryKind): MemoryKind {
  const t = tags.find((x) => x.startsWith(KIND_TAG_PREFIX));
  return (t?.slice(KIND_TAG_PREFIX.length) as MemoryKind | undefined) ?? fallback;
}

function pickStringArray(
  detail: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string[] | undefined {
  const v = detail?.[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}
