/**
 * K.4 — ExecutionPlanner (arch §7, ADR-001). The Planning Runtime skeleton:
 * it turns (query, tenant policy, capability snapshot) into a declarative
 * ExecutionPlan or, for compound queries, an ordered plan DAG. It NEVER
 * executes the plan (GEPA does, ADR-000 §3.4) and NEVER re-checks a
 * storage-layer ACL/withholding decision (ADR-010 owns that).
 *
 * Pipeline (arch Flow 2, fixed order — §3.2/§3.3):
 *   compliance_gate → classify_intent → analyze_freshness → estimate_cost →
 *   negotiate_capabilities → [acl_filter → rank → fuse_dedup →
 *   attach_provenance]  (the bracketed tail is delegated to retrieval)
 *
 * Executability at K.4 is index-path only (A1): `graph`/`live_mcp` plans are
 * emitted correct and executed by K.6/K.8. A plan whose primary is
 * unexecutable and whose fallback is `index` is served by the fallback —
 * the roadmap's "produce the documented plan, execute what exists" posture.
 */

import { randomUUID } from 'crypto';
import {
  classifyIntent,
  assertStageOrder,
  negotiateCapabilities,
  analyzeFreshness,
  PLAN_STAGE_ORDER,
  type Intent,
  type RetrievalPath,
  type PlanStageName,
  type SupportFlag,
  type EffectiveCapabilities,
  type FreshnessClass,
  type FallbackPolicy,
} from './contract.js';
import { estimateCost, type CostEstimate, type DeploymentProfile } from './CostEstimator.js';

// ── Inputs ──────────────────────────────────────────────────────────────

/** A connector as the registry reports it to the planner at plan time. */
export interface ConnectorSnapshot {
  readonly connectorId: string;
  /** §10.4: disabled connectors do NOT enter negotiation or fan-out. */
  readonly enabled: boolean;
  /** tenant_connectors.effective_capabilities (install subset, A3). */
  readonly effectiveCapabilities: EffectiveCapabilities;
  readonly capabilityVersion: string;
  readonly heartbeatSeconds: number;
}

export interface PlanInput {
  readonly tenantId: string;
  readonly query: string;
  readonly connectors: readonly ConnectorSnapshot[];
  /** ADR-006-owned; the planner only consumes the verdict (§3.2). */
  readonly complianceGate?: (query: string) => 'allow' | 'block';
  /**
   * Coarse v0 subject-freshness hint (Expected to evolve — field-level is
   * K.6/ADR-008). Defaults to a keyword heuristic over the query.
   */
  readonly subjectFreshnessClass?: FreshnessClass;
  readonly indexedAtMs?: number;
  readonly nowMs?: number;
  readonly profile?: DeploymentProfile;
}

// ── Outputs ─────────────────────────────────────────────────────────────

export interface ConnectorDirective {
  readonly connectorId: string;
  readonly sync: 'webhook' | 'poll';
  readonly fullSync: boolean;
  readonly aclValidateLive: boolean;
  readonly activityBoost: boolean;
  readonly aclUntrusted: boolean;
  readonly indexOnlyFlagStaleness: boolean;
  /** The fallback policies that fired, for provenance/debugging. */
  readonly appliedFallbacks: readonly FallbackPolicy[];
}

export interface PlanStep {
  readonly kind: 'retrieval' | 'action';
  readonly connectorId: string;
  readonly detail: string;
}

export interface ExecutionPlan {
  readonly planId: string;
  readonly blocked: false;
  readonly intent: Intent;
  readonly primaryPath: RetrievalPath;
  readonly fallbackPath: RetrievalPath | null;
  readonly maxDataAgeMs: number | null;
  readonly stages: readonly PlanStageName[];
  readonly connectorDirectives: readonly ConnectorDirective[];
  readonly steps: readonly PlanStep[];
  readonly capabilityVersionAtPlan: Readonly<Record<string, string>>;
  /** Stamped into the ADR-000 §3.4 GEPA retrieval envelope. */
  readonly planRef: string;
}

export interface BlockedPlan {
  readonly planId: string;
  readonly blocked: true;
  readonly reason: string;
}

/** Compound queries decompose into an ordered DAG of single-intent sub-plans (§3.7). */
export interface PlanDAG {
  readonly planId: string;
  readonly intent: 'compound';
  readonly subPlans: readonly ExecutionPlan[];
}

export type PlannerOutput = ExecutionPlan | BlockedPlan | PlanDAG;

// ── The retrieval capabilities a non-action plan negotiates over ──────────
const RETRIEVAL_CAPABILITIES: readonly SupportFlag[] = [
  'changeFeed', 'content', 'acl', 'groups', 'activitySignals', 'webhooks', 'deltaSync',
];

/**
 * The live-check max data age for a Critical lookup (ADR-001 §6 operational
 * default; §7.2 example 2 "Max data age: 30 seconds"). This is a property of
 * the LIVE path — how fresh the live MCP read must be — NOT the index
 * staleness bound (which for Critical is 0: the index is never trusted).
 * The two are distinct; conflating them is the §6.4/§7.2 subtlety.
 */
const LIVE_CHECK_MAX_DATA_AGE_MS = 30_000;

export class ExecutionPlanner {
  /**
   * Build a plan (or DAG, or block). Pure — no I/O, safe to re-invoke
   * mid-DAG when an intermediate result changes the next stage (§3.1).
   */
  plan(input: PlanInput): PlannerOutput {
    const planId = randomUUID();

    // ── Stage 1: compliance hard-gate BEFORE classification (§3.2, Flow 2).
    const gate = input.complianceGate ?? (() => 'allow' as const);
    let verdict: 'allow' | 'block';
    try {
      verdict = gate(input.query);
    } catch {
      verdict = 'block'; // fail-closed
    }
    if (verdict === 'block') {
      return { planId, blocked: true, reason: 'compliance_gate' };
    }

    // ── Stage 2: classify intent.
    const intent = classifyIntent(input.query);

    // Compound decomposes into an ordered DAG (§3.7); each sub-plan is
    // independently built and gated (recursion re-runs the gate per sub-plan).
    if (intent === 'compound') {
      return this.decompose(planId, input);
    }

    return this.buildSingle(planId, intent, input);
  }

  private buildSingle(planId: string, intent: Intent, input: PlanInput): ExecutionPlan {
    const now = input.nowMs ?? Date.now();
    const indexedAt = input.indexedAtMs ?? now;

    // ── Stage 3: analyze freshness (document-level v0).
    const freshnessClass = input.subjectFreshnessClass ?? inferSubjectFreshness(input.query);
    const freshness = analyzeFreshness(freshnessClass, indexedAt, now);

    // ── Retrieval-mode selection (§7.3) — v0 heuristics, Expected to evolve.
    const mode = selectRetrievalMode(input.query, intent, freshness.requiresLive);

    // ── Stage 4: estimate cost of the chosen primary path.
    const enabled = input.connectors.filter((c) => c.enabled);
    const _cost: CostEstimate = estimateCost({
      path: mode.primaryPath,
      freshnessClass,
      liveConnectorCount: enabled.length,
      ...(input.profile ? { profile: input.profile } : {}),
    });

    // ── Stage 5: negotiate capabilities over ENABLED connectors only (§10.4).
    const directives = enabled.map((c) => negotiateConnector(c, RETRIEVAL_CAPABILITIES));

    // Action steps (only present for action intent); dropped for any
    // connector missing `actions` (remove_action_steps policy).
    const steps: PlanStep[] =
      intent === 'action'
        ? enabled
            .filter((c) => c.effectiveCapabilities.actions === true)
            .map((c) => ({ kind: 'action' as const, connectorId: c.connectorId, detail: input.query }))
        : [];

    const stages = stagesFor(intent);
    assertStageOrder(stages); // INV-2 construction-time guard

    return {
      planId,
      blocked: false,
      intent,
      primaryPath: mode.primaryPath,
      fallbackPath: mode.fallbackPath,
      maxDataAgeMs: mode.maxDataAgeMs,
      stages,
      connectorDirectives: directives,
      steps,
      capabilityVersionAtPlan: Object.fromEntries(enabled.map((c) => [c.connectorId, c.capabilityVersion])),
      planRef: planId,
    };
  }

  /**
   * Compound decomposition (§3.7): a retrieval sub-plan feeding an action
   * sub-plan, in order. Each is built through buildSingle so it carries its
   * own gates and stages; a compound plan is NEVER gated once at the top.
   */
  private decompose(planId: string, input: PlanInput): PlanDAG {
    const [retrievalClause, actionClause] = splitCompound(input.query);
    const retrievalPlan = this.buildSingle(randomUUID(), 'retrieval', { ...input, query: retrievalClause });
    const actionPlan = this.buildSingle(randomUUID(), 'action', { ...input, query: actionClause });
    return { planId, intent: 'compound', subPlans: [retrievalPlan, actionPlan] };
  }
}

// ── Retrieval-mode selection (§7.3, v0) ───────────────────────────────────

interface ModeSelection {
  readonly primaryPath: RetrievalPath;
  readonly fallbackPath: RetrievalPath | null;
  readonly maxDataAgeMs: number | null;
}

/**
 * Map (query shape, intent, freshness) onto a plan path. v0 heuristics
 * reproduce the four §7.2 documented shapes; the *method* is architectural,
 * the keyword sets are Expected to evolve (§6). A misclassification widens
 * the plan (e.g. index instead of graph), never a permission bypass.
 */
export function selectRetrievalMode(
  query: string,
  intent: Intent,
  requiresLive: boolean,
): ModeSelection {
  const q = query.toLowerCase();

  // Relational/ownership question → knowledge graph, index as fallback.
  if (/\bwho owns\b|\bowner of\b|\brelated to\b|\bdepends on\b/.test(q)) {
    return { primaryPath: 'graph', fallbackPath: 'index', maxDataAgeMs: null };
  }

  // Live-required subject (transactional/critical) → live MCP, no fallback,
  // bounded by the live-check max data age (§7.2 example 2: 30s).
  if (requiresLive) {
    return { primaryPath: 'live_mcp', fallbackPath: null, maxDataAgeMs: LIVE_CHECK_MAX_DATA_AGE_MS };
  }

  // Corpus-wide retrieval that implies graph expansion → hybrid.
  if (intent === 'retrieval' && /\b(all|across|every)\b/.test(q) && /\bdocs?\b|\bdesign\b|\breports?\b/.test(q)) {
    return { primaryPath: 'hybrid', fallbackPath: null, maxDataAgeMs: null };
  }

  // Default: index path, authoritative.
  return { primaryPath: 'index', fallbackPath: 'none', maxDataAgeMs: null };
}

/**
 * v0 subject-freshness heuristic (Expected to evolve; field-level is K.6).
 * Transactional/critical subjects (approvals, invoices, live status) force a
 * live check; policy/reference material is static/operational.
 */
export function inferSubjectFreshness(query: string): FreshnessClass {
  const q = query.toLowerCase();
  if (/\b(approved|approve|invoice|paid|payment|balance|status of|in stock|order \d)\b/.test(q)) {
    return 'critical';
  }
  if (/\b(policy|handbook|guideline|readme|reference)\b/.test(q)) return 'static';
  return 'operational';
}

// ── Per-connector negotiation → directive ─────────────────────────────────

export function negotiateConnector(
  snapshot: ConnectorSnapshot,
  required: readonly SupportFlag[],
): ConnectorDirective {
  const decisions = negotiateCapabilities(required, snapshot.effectiveCapabilities);
  const fired = new Set<FallbackPolicy>();
  for (const d of decisions) if (d.missing && d.policy) fired.add(d.policy);

  return {
    connectorId: snapshot.connectorId,
    sync: fired.has('scheduled_polling') ? 'poll' : 'webhook',
    fullSync: fired.has('force_full_sync'),
    aclValidateLive: fired.has('validate_acl_live'),
    activityBoost: !fired.has('rank_without_activity'),
    aclUntrusted: fired.has('mark_acl_untrusted'),
    indexOnlyFlagStaleness: fired.has('index_only_flag_staleness'),
    appliedFallbacks: [...fired],
  };
}

// ── Stage assembly ────────────────────────────────────────────────────────

/**
 * The stage list for an intent. Action-only intents skip the retrieval tail
 * (acl_filter/rank/fuse_dedup) but keep compliance/classify/negotiate; every
 * list is a monotonic subsequence of PLAN_STAGE_ORDER (asserted by caller).
 */
function stagesFor(intent: Intent): PlanStageName[] {
  if (intent === 'action') {
    return ['compliance_gate', 'classify_intent', 'negotiate_capabilities', 'attach_provenance'];
  }
  return [...PLAN_STAGE_ORDER];
}

// ── Compound splitting (v0) ───────────────────────────────────────────────

/** Split a compound query into (retrieval clause, action clause) at the conjunction. */
function splitCompound(query: string): [string, string] {
  const m = query.split(/\band\b/i);
  if (m.length >= 2) {
    return [m[0]!.trim(), m.slice(1).join('and').trim()];
  }
  return [query, query];
}
