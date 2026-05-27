/**
 * T.−1: IActionGate — the gate every real-world action passes through.
 *
 * Wrap an execution call with `await actionGate.gate(ctx)`. The returned
 * decision indicates whether to execute live, record a dry-run proposal,
 * route to a shadow target, request approval, or block outright.
 *
 * With the action_trust_ladder.enabled feature flag off, `gate()` returns
 * { mode: 'execute' } deterministically — behavior is byte-identical to
 * the pre-T.−1 codepath.
 */
import { createHash } from 'crypto';
import type { ActionClass } from './ActionClass.js';

export interface ActionContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly actionClass: ActionClass;
  /** Deterministic id for idempotency: same actionId is never doubled. */
  readonly actionId: string;
  /** Human-readable: e.g. "delete file foo.txt". */
  readonly summary: string;
  /** Full machine-readable detail; surfaced to operators. */
  readonly payload: unknown;
  readonly rollback?: RollbackEnvelope;
  /**
   * Per-task tenant calibration snapshot, threaded through every action
   * emitted by the task. Resolved once at task start via CalibrationService
   * (T.5.a) and pinned for the snapshot's lifetime. The trust ladder reads
   * accountAgeDays and per-class scores from here to avoid a DB round-trip
   * on every gate() call.
   *
   * Known limitation: long-running batch tasks pin a single snapshot for
   * the task's entire lifetime. A task running for > 24 h with a stale
   * snapshot may miss auto-promotion thresholds crossed mid-task. No
   * checkpoint/refresh hook is wired today; callers needing fresh state
   * mid-task must split the work across separate ActionContexts. Future
   * work: a CalibrationService.refresh(snapshot) hook with an explicit
   * staleness threshold.
   */
  readonly calibrationSnapshot: TenantReadinessSnapshot;
}

/**
 * Minimal subset of TenantReadiness (T.5.a) needed by the gate. Carries
 * pinned accountAgeDays + per-class scores so the gate does not re-query
 * the DB. The `sourceSig` is issued by CalibrationService and verified by
 * the gate to prevent inline construction by tools.
 */
export interface TenantReadinessSnapshot {
  readonly tenantId: string;
  readonly accountAgeDays: number;
  readonly actionClassScores: Readonly<Record<string, number>>;
  readonly snapshotAt: string;
  readonly sourceSig: string;
}

export interface RollbackEnvelope {
  readonly kind: 'trivial' | 'reversible_with_cost' | 'irreversible';
  readonly details: string;
  readonly rollbackPlan?: unknown;
}

export type GateDecision =
  | { mode: 'execute' }
  | { mode: 'dry_run'; proposalId: string }
  | { mode: 'shadow'; shadowId: string }
  | { mode: 'require_approval'; approvalId: string }
  | { mode: 'forbidden'; reason: string }
  /**
   * S.2: rate-limit decision. Returned when the (tenant × actionClass) token
   * bucket is empty under the policy's `soft` enforcement mode. Callers MUST
   * either back off and retry after `retryAfterMs` OR abort if the wait is
   * too long. Treating this as `forbidden` is INCORRECT — it is retryable.
   *
   * Hard enforcement returns `forbidden { reason: 'rate_limit_exceeded' }`
   * instead, signalling the caller to give up.
   */
  | { mode: 'rate_limited'; retryAfterMs: number };

/** Minimal principal shape — the gate needs identity for audit; full type lives in @oweibo/db. */
export interface GatePrincipal {
  readonly sub: string;
  readonly scopes: readonly string[];
  readonly ctx: { readonly tenantId?: string };
}

export interface IActionGate {
  gate(ctx: ActionContext): Promise<GateDecision>;

  /**
   * Called when a dry_run / shadow / require_approval proposal is later
   * promoted to live execution. Updates observation counters based on the
   * actual live-execution outcome supplied.
   */
  promote(
    promoteId: string,
    principal: GatePrincipal,
    outcome: 'success' | 'failure',
  ): Promise<void>;

  /** Called when a proposal is rejected. Counts as 1 observation, 1 rejection. */
  reject(promoteId: string, principal: GatePrincipal, reason: string): Promise<void>;
}

/**
 * Audit-fix (T.−1 #3): the canonical reference implementation every
 * action-issuing tool (kilo-pipeline, browser-tool, channel-gateway, ...)
 * MUST use to compute `ActionContext.actionId`. Centralizing the
 * computation here means:
 *
 *   - the (tenant_id, action_id) UNIQUE on action_proposals reliably
 *     dedupes retries of the same logical action
 *   - two different issuers can't accidentally collide on the same id
 *     for semantically-different actions (because originatingTaskId +
 *     stepNumber differ)
 *   - a retry after a transient failure produces the same id as long as
 *     the inputs are reproducible
 *
 * Inputs:
 *   - tenantId            — already namespaces the id; required
 *   - actionClass         — required; trust-ladder uses it for classification
 *   - payload             — JSON-serializable; canonicalized below before hashing
 *   - originatingTaskId   — the agent task that emitted this action;
 *                           use a stable per-task uuid, not per-attempt
 *   - stepNumber          — 0-based action index within the task;
 *                           differentiates per-action within one task
 *
 * Output: 32-character hex prefix of SHA-256(canonicalForm). The prefix
 * is long enough to keep collision probability negligible (~2^-64 over
 * 32 chars) while staying under the 64-char column constraint on
 * action_proposals.action_id.
 */
export function canonicalActionId(args: {
  readonly tenantId: string;
  readonly actionClass: ActionClass;
  readonly payload: unknown;
  readonly originatingTaskId: string;
  readonly stepNumber: number;
}): string {
  const payloadHash = createHash('sha256')
    .update(canonicalJson(args.payload))
    .digest('hex');
  const canonical = [
    args.tenantId,
    args.actionClass,
    args.originatingTaskId,
    String(args.stepNumber),
    payloadHash,
  ].join('\x1f'); // \x1f = ASCII unit separator; not legal in any field
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Deterministic JSON serialization: keys sorted at every object level
 * so `{a: 1, b: 2}` and `{b: 2, a: 1}` hash identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
}
