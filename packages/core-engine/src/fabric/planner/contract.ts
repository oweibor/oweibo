/**
 * ADR-001 contract predicates — the Query Planner as pure functions.
 *
 * This is the *contract*, not the running planner: intent classification,
 * the fixed plan-stage order (INV-2), the fallback policy table (§10.2),
 * the freshness/staleness decision, the quota-exhaustion fork (§7.5), and
 * the semantic-cache key + eligibility predicates (INV-3, INV-13). All ship
 * green at ADR-001 ratification. The ExecutionPlanner that composes them is
 * the K.4 skeleton; the running semantic cache is K.5; live-path fan-out is
 * K.6; the graph path is K.8.
 *
 * Placement is normative (§3.2/§3.3): the planner emits a *data* plan and
 * NEVER executes it, NEVER re-checks a storage-layer ACL/withholding
 * decision (ADR-010 owns that), and NEVER treats compliance as a rankable
 * hint — the compliance gate runs BEFORE classification and can terminate
 * planning (arch Flow 2).
 */

import { DEFAULT_STALENESS_BOUNDS_MS, type FreshnessClass } from '../permissions/contract.js';

export type { FreshnessClass };

// ── Intent ────────────────────────────────────────────────────────────────

/** Query nature (arch §7.1). Compound = a retrieval feeding an action, etc. */
export type Intent = 'lookup' | 'retrieval' | 'action' | 'compound';

/**
 * The declarative retrieval paths a plan may name (arch §7.1 bottom row).
 * The planner NAMES a path; executability is a K-step property — only
 * `index` runs at K.4 (`graph`=K.8, `live_mcp`=K.6, `hybrid`=index+graph).
 */
export type RetrievalPath = 'index' | 'graph' | 'live_mcp' | 'hybrid' | 'none';

// ── Fixed plan-stage order (INV-2 + Flow-2 compliance ordering) ─────────────

/**
 * The fixed stage sequence every non-blocked plan carries (ADR-001 §3.3).
 * `compliance_gate` precedes `classify_intent` (arch Flow 2, INV-4 ordering
 * witness); `rank` NEVER precedes `acl_filter` (INV-2). The order is a
 * contract, not a default — changing it reopens ADR-001 (§8).
 */
export const PLAN_STAGE_ORDER = [
  'compliance_gate',
  'classify_intent',
  'analyze_freshness',
  'estimate_cost',
  'negotiate_capabilities',
  'acl_filter',
  'rank',
  'fuse_dedup',
  'attach_provenance',
] as const;

export type PlanStageName = (typeof PLAN_STAGE_ORDER)[number];

const STAGE_INDEX: Readonly<Record<PlanStageName, number>> = Object.fromEntries(
  PLAN_STAGE_ORDER.map((s, i) => [s, i]),
) as Record<PlanStageName, number>;

/**
 * Construction-time INV-2 guard: a plan's stages MUST appear in strictly
 * increasing canonical order. A plan that places `rank` before `acl_filter`
 * (or `classify_intent` before `compliance_gate`) cannot be constructed.
 * Throws on violation — mis-ordered plans are a defect, not a runtime branch.
 */
export function assertStageOrder(stages: readonly PlanStageName[]): void {
  for (let i = 1; i < stages.length; i++) {
    const prev = STAGE_INDEX[stages[i - 1]!];
    const cur = STAGE_INDEX[stages[i]!];
    if (cur <= prev) {
      throw new Error(
        `ADR-001 §3.3 (INV-2): plan stages out of order — '${stages[i - 1]}' (${prev}) ` +
          `must precede '${stages[i]}' (${cur})`,
      );
    }
  }
}

/**
 * Intent classification (v0, keyword-shape — Expected to evolve, §6). A
 * misclassification degrades to a broader plan, NEVER a permission bypass
 * (permissions are the storage layer's, not the planner's). Order matters:
 * compound is checked first (it contains an action verb AND a retrieval
 * verb), then action, then lookup vs retrieval by phrasing shape.
 */
export function classifyIntent(query: string): Intent {
  const q = query.toLowerCase();
  const hasAction = ACTION_VERBS.some((v) => q.includes(v));
  const hasRetrieval = RETRIEVAL_VERBS.some((v) => q.includes(v)) || q.includes('?');

  if (hasAction && hasRetrieval && / and | then |, /.test(q)) return 'compound';
  if (hasAction) return 'action';

  // lookup = a pointed single-fact question ("who owns X?", "has Y approved Z?");
  // retrieval = search/summarize over a corpus ("what is our …", "summarize all …").
  if (LOOKUP_SHAPES.some((re) => re.test(q))) return 'lookup';
  return 'retrieval';
}

const ACTION_VERBS = ['file ', 'create ', 'open a ', 'send ', 'update ', 'delete ', 'assign ', 'post '];
const RETRIEVAL_VERBS = ['summarize', 'find', 'search', 'list', 'show me', 'what is', 'what are'];
const LOOKUP_SHAPES: readonly RegExp[] = [
  /^who\b/,
  /\bwho owns\b/,
  /^has\b.*\b(approved|completed|shipped|paid|signed)\b/,
  /^is\b.*\?/,
  /^does\b.*\?/,
  /\bhow many\b/,
];

// ── Capability negotiation and the §10.2 fallback table ─────────────────────

/**
 * Structural mirror of the SDK's SupportFlag vocabulary (ADR-012 §3.3,
 * `connector-sdk/src/contract/manifestTruthfulness.ts`). Deliberately NOT
 * imported: core-engine takes no @oweibo/connector-sdk dependency (same
 * posture as MembershipSyncService's port mirrors). The K.4 composition
 * point is where any drift from the certified list would surface.
 */
export type SupportFlag =
  | 'changeFeed'
  | 'content'
  | 'acl'
  | 'principals'
  | 'activity'
  | 'actions'
  | 'deltaSync'
  | 'webhooks'
  | 'groups'
  | 'activitySignals';

export const SUPPORT_FLAGS: readonly SupportFlag[] = [
  'changeFeed', 'content', 'acl', 'principals', 'activity',
  'actions', 'deltaSync', 'webhooks', 'groups', 'activitySignals',
];

/** Per-install capability subset (tenant_connectors.effective_capabilities). */
export type EffectiveCapabilities = Readonly<Partial<Record<SupportFlag, boolean>>>;

/**
 * The degradation applied when a required capability is missing (§3.4). Each
 * flag has EXACTLY ONE policy — the table is total over SUPPORT_FLAGS (a new
 * flag with no row trips the totality test, forcing a decision, §8).
 */
export type FallbackPolicy =
  | 'force_full_sync'          // deltaSync missing → re-crawl every cycle
  | 'remove_action_steps'      // actions missing → drop action steps from the plan
  | 'scheduled_polling'        // webhooks missing → poll instead of push
  | 'validate_acl_live'        // groups missing → per-retrieval live ACL (slower, correct)
  | 'rank_without_activity'    // activity/activitySignals missing → no recency/activity boost
  | 'index_only_flag_staleness' // content missing → no live read; serve index, tag staleness
  | 'mark_acl_untrusted'       // acl missing → retrieval withholds per ADR-010
  | 'no_index_contribution'    // changeFeed missing → connector never enters the index path
  | 'install_order_refusal';   // principals missing on an identity connector → ADR-010 refusal

export const FALLBACK_POLICY: Readonly<Record<SupportFlag, FallbackPolicy>> = {
  deltaSync: 'force_full_sync',
  actions: 'remove_action_steps',
  webhooks: 'scheduled_polling',
  groups: 'validate_acl_live',
  activity: 'rank_without_activity',
  activitySignals: 'rank_without_activity',
  content: 'index_only_flag_staleness',
  acl: 'mark_acl_untrusted',
  changeFeed: 'no_index_contribution',
  principals: 'install_order_refusal',
};

export interface FallbackDecision {
  readonly capability: SupportFlag;
  readonly missing: boolean;
  /** Present iff missing — the policy that applies. */
  readonly policy?: FallbackPolicy;
}

/**
 * For each required capability, decide whether the connector's install
 * subset satisfies it and, if not, which fallback policy applies. A3:
 * absent/NULL effective capabilities mean the flag is MISSING (fail-closed
 * negotiation), never present-by-default.
 */
export function negotiateCapabilities(
  required: readonly SupportFlag[],
  effective: EffectiveCapabilities | null | undefined,
): FallbackDecision[] {
  const caps = effective ?? {};
  return required.map((capability) => {
    const missing = caps[capability] !== true;
    return missing
      ? { capability, missing, policy: FALLBACK_POLICY[capability] }
      : { capability, missing };
  });
}

// ── Quota-exhaustion fork (§7.5) — freshness-class-forked, exported data ─────

export interface QuotaExhaustionPolicy {
  /** Static/Operational/Transactional fall back to index; Critical does NOT. */
  readonly fallBackToIndex: boolean;
  readonly attachStalenessWarning: boolean;
  readonly logQuotaEvent: boolean;
  /** Critical only: return an explicit error to the user and alert. */
  readonly errorAndAlert: boolean;
}

export const QUOTA_EXHAUSTION_POLICY: Readonly<Record<FreshnessClass, QuotaExhaustionPolicy>> = {
  static: { fallBackToIndex: true, attachStalenessWarning: false, logQuotaEvent: false, errorAndAlert: false },
  operational: { fallBackToIndex: true, attachStalenessWarning: true, logQuotaEvent: false, errorAndAlert: false },
  transactional: { fallBackToIndex: true, attachStalenessWarning: true, logQuotaEvent: true, errorAndAlert: false },
  // Critical NEVER falls back to a stale index (§7.5, INV-3-adjacent): a
  // Critical answer the system cannot verify live is withheld, not served.
  critical: { fallBackToIndex: false, attachStalenessWarning: false, logQuotaEvent: true, errorAndAlert: true },
};

// ── Freshness analysis (document-level at K.4; field-level is K.6/ADR-008) ──

export interface FreshnessDecision {
  readonly freshnessClass: FreshnessClass;
  /** Does the indexed copy still sit within the class's staleness bound? */
  readonly meetsIndexTolerance: boolean;
  /** Critical/compliance always require live validation (§6.4). */
  readonly requiresLive: boolean;
  /** Live-check bound in ms; null when the index is authoritative. */
  readonly maxDataAgeMs: number | null;
}

/**
 * Given the applicable freshness class and how old the indexed copy is,
 * decide whether the index suffices or a live check is required. Critical
 * ALWAYS requires live (bound 0, §6.4); other classes require live only once
 * the index age exceeds the class's staleness bound (§5.2 defaults, reused
 * from ADR-010's DEFAULT_STALENESS_BOUNDS_MS — never forked here).
 */
export function analyzeFreshness(
  freshnessClass: FreshnessClass,
  indexedAtMs: number,
  nowMs: number,
  bounds: Readonly<Record<FreshnessClass, number>> = DEFAULT_STALENESS_BOUNDS_MS,
): FreshnessDecision {
  const bound = bounds[freshnessClass];
  const age = Math.max(0, nowMs - indexedAtMs);
  if (freshnessClass === 'critical') {
    return { freshnessClass, meetsIndexTolerance: false, requiresLive: true, maxDataAgeMs: bound };
  }
  const meets = age <= bound;
  return {
    freshnessClass,
    meetsIndexTolerance: meets,
    requiresLive: !meets,
    maxDataAgeMs: meets ? null : bound,
  };
}

// ── Semantic cache contract (INV-3, INV-13) — K.5 arms the running cache ────

export interface CacheKeyInput {
  readonly tenantId: string;
  /**
   * The canonical identity (ADR-002). At K.4 this slot is filled by the
   * per-source principal ref as a provisional stand-in (A2); its structural
   * presence — non-optional — is the INV-13 guarantee, not its source.
   */
  readonly canonicalIdentity: string;
  readonly policyVersion: string;
  /** Reference/hash of the intent embedding (arch §7.7). */
  readonly intentEmbeddingRef: string;
}

/**
 * INV-13: the cache key STRUCTURALLY contains the canonical identity, so two
 * identities can never collide by construction. Components are length-
 * prefixed so no component boundary can be forged by an embedded delimiter.
 * Pure and total; the test asserts key derivation, not behavior (§7).
 */
export function deriveCacheKey(input: CacheKeyInput): string {
  const parts = [input.tenantId, input.canonicalIdentity, input.policyVersion, input.intentEmbeddingRef];
  return parts.map((p) => `${p.length}:${p}`).join('|');
}

/**
 * INV-3: Critical-class content is NEVER cacheable — unconditionally, before
 * any other eligibility check. The remaining §7.7 conditions (event
 * invalidation, heartbeat-silence suspension, age within class, policy
 * version) are evaluated by the running cache at K.5; this predicate is the
 * one that is contract, not tunable.
 */
export function isCacheable(freshnessClass: FreshnessClass): boolean {
  return freshnessClass !== 'critical';
}
