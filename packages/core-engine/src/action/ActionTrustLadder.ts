/**
 * T.−1: ActionTrustLadder — the runtime implementation of IActionGate.
 *
 * Resolves a (tenant, action_class) trust state from the pinned/observed state
 * in oweibo.tenant_action_class_state (when present) or the platform-default
 * matrix below (when absent). Records dry-run / shadow / require-approval
 * proposals into oweibo.action_proposals.
 *
 * Hot path: gate() reads accountAgeDays and per-class scores from the caller-
 * supplied calibration snapshot (T.5.a) to avoid a DB round-trip on every
 * action. A DB query is only required when:
 *   - a tenant has a row in tenant_action_class_state (rare for established
 *     tenants; common only for cold-start tenants with pinned modes), or
 *   - the gate decides to write a proposal row (dry_run / shadow / approval).
 *
 * Backwards compatibility: with feature flag action_trust_ladder.enabled =
 * false, gate() returns { mode: 'execute' } deterministically. With the flag
 * on but no row in tenant_action_class_state (zero rows = pre-existing
 * tenant), the platform-default matrix returns 'execute' for any tenant with
 * accountAgeDays >= 30.
 *
 * Auto-promotion: a class with observations >= 10, success_rate >= 0.95,
 * accountAgeDays >= 7, not pinned, and not in the always-require-approval
 * group can auto-promote from dry_run to execute. Promotion runs lazily on
 * the next gate() call after the threshold is reached.
 */
import type { Pool, PoolClient } from 'pg';
import { randomUUID, createHash } from 'crypto';
import type {
  ActionClass,
  ActionContext,
  GateDecision,
  GatePrincipal,
  IActionGate,
} from '@oweibo/core-contracts';
import { isCoreActionClass, type CoreActionClass } from '@oweibo/core-contracts';

// ── Trust modes ────────────────────────────────────────────────────────────

export type TrustMode = 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden';

interface ResolvedState {
  mode: TrustMode;
  /** True if this state came from tenant_action_class_state (explicit row). */
  fromExplicit: boolean;
  /** Non-null when an operator has pinned this class. */
  pinnedBy: string | null;
  observations: number;
  successes: number;
}

// ── Defaults matrix ────────────────────────────────────────────────────────
//
// Three columns capture the cold-start tiers:
//   - young: accountAgeDays <  7
//   - young-with-signal: accountAgeDays >= 7 && score >= 0.6
//   - established: accountAgeDays >= 30 && score >= 0.85
//
// For classes in CLASSES_ALWAYS_REQUIRE_APPROVAL the matrix is uniformly
// require_approval; demotion requires an explicit operator workflow that is
// itself audited (RFC-marked, out of scope here).

const CLASSES_ALWAYS_REQUIRE_APPROVAL: ReadonlySet<CoreActionClass> = new Set<CoreActionClass>([
  'financial.payment',
  'personnel.access_grant',
  'personnel.access_revoke',
  'irreversible.delete_resource',
  'irreversible.public_publish',
]);

interface DefaultRow {
  young: TrustMode;
  withSignal: TrustMode;
  established: TrustMode;
}

const PLATFORM_DEFAULTS: Readonly<Record<CoreActionClass, DefaultRow>> = {
  'read.local':                    { young: 'execute',          withSignal: 'execute',          established: 'execute' },
  'read.external_api':             { young: 'execute',          withSignal: 'execute',          established: 'execute' },
  'read.tenant_db':                { young: 'execute',          withSignal: 'execute',          established: 'execute' },
  'write.local.scratch':           { young: 'execute',          withSignal: 'execute',          established: 'execute' },
  'write.local.repo_nonprod':      { young: 'dry_run',          withSignal: 'execute',          established: 'execute' },
  'write.local.repo_prod':         { young: 'require_approval', withSignal: 'require_approval', established: 'execute' },
  'write.external_api.nonprod':    { young: 'dry_run',          withSignal: 'shadow',           established: 'execute' },
  'write.external_api.prod':       { young: 'require_approval', withSignal: 'require_approval', established: 'execute' },
  'write.tenant_db.nonprod':       { young: 'dry_run',          withSignal: 'shadow',           established: 'execute' },
  'write.tenant_db.prod':          { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
  'comm.internal':                 { young: 'dry_run',          withSignal: 'execute',          established: 'execute' },
  'comm.external_email':           { young: 'require_approval', withSignal: 'dry_run',          established: 'execute' },
  'comm.external_message':         { young: 'require_approval', withSignal: 'dry_run',          established: 'execute' },
  'financial.payment':             { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
  'personnel.access_grant':        { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
  'personnel.access_revoke':       { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
  'irreversible.delete_resource':  { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
  'irreversible.public_publish':   { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
  'deploy.nonprod':                { young: 'dry_run',          withSignal: 'execute',          established: 'execute' },
  'deploy.prod':                   { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
  'unclassified':                  { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
};

// ── Auto-promotion thresholds ──────────────────────────────────────────────

const AUTO_PROMOTE_MIN_OBS = 10;
const AUTO_PROMOTE_MIN_RATE = 0.95;
const AUTO_PROMOTE_MIN_AGE_DAYS = 7;

// ── Constructor options ────────────────────────────────────────────────────

export interface ActionTrustLadderOptions {
  /**
   * Returns true when the trust ladder should run. When false, gate() returns
   * { mode: 'execute' } deterministically (behavior byte-identical to today).
   * Default: env('ACTION_TRUST_LADDER_ENABLED') === 'true'.
   */
  isEnabled?: () => boolean;
  /**
   * Shadow-only mode: the gate still computes its decision and writes the
   * proposal row, but the returned mode is always 'execute'. Used during
   * the 14-day rollout window. Default: env('ACTION_TRUST_LADDER_SHADOW_ONLY')
   * === 'true'.
   */
  isShadowOnly?: () => boolean;
  /** Optional override for clock; tests pin time. */
  now?: () => Date;
  /**
   * S.1: optional SLA attacher. When supplied AND the proposal lands in
   * `require_approval` mode, the gate calls `attachSla(proposalId,
   * tenantId, actionClass)` after writing the proposal. Failures are
   * swallowed so the gate decision is never blocked by SLA-side issues.
   */
  slaAttacher?: {
    attachSla(proposalId: string, tenantId: string, actionClass: string): Promise<void>;
  };
  /**
   * S.2: optional rate limiter. Consulted after class resolution but
   * before the trust-mode decision. When the bucket is empty, gate
   * short-circuits with `rate_limited` (soft) or `forbidden` (hard).
   * When omitted, no rate-limit check runs — byte-identical to today.
   */
  rateLimiter?: {
    tryConsume(tenantId: string, actionClass: string): Promise<
      | { kind: 'allowed' }
      | { kind: 'soft'; retryAfterMs: number; limitingWindow: 'minute' | 'hour' | 'day' }
      | { kind: 'hard'; reason: string }
    >;
  };
  /**
   * S.4: optional multi-party approval / grant service. Consulted ONLY
   * when the resolved mode is `require_approval` — if an active grant
   * covers this (tenant, class, payload), the gate downgrades to
   * `execute` and records an audit proposal tagged with `grant_id`.
   * When omitted, no grant check runs — byte-identical to today.
   */
  grantChecker?: {
    tryConsume(req: {
      readonly tenantId: string;
      readonly actionClass: string;
      readonly grantedToKind: 'agent' | 'user';
      readonly grantedToUserId?: string;
      readonly payload: unknown;
    }): Promise<{ kind: 'no_grant' } | { kind: 'grant_consumed'; grantId: string }>;
  };
  /**
   * S.4: principal kind for grant matching. Most callers run as an agent;
   * UI-initiated retries run as the authenticated user. Defaults to
   * 'agent'.
   */
  grantPrincipalKind?: () => 'agent' | 'user';
  /**
   * S.5.a: optional content inspector registry. Consulted AFTER class
   * resolution but BEFORE proposal write / grant check / rate limiter.
   * Inspectors may only upgrade restrictions (execute → require_approval
   * or forbid). A `forbid` verdict terminates the gate immediately.
   * When omitted, no inspection runs — byte-identical to today.
   *
   * Per-inspector verdicts are persisted to
   * oweibo.content_inspection_results for audit.
   */
  contentInspectors?: {
    run(ctx: import('@oweibo/core-contracts').ActionContext): Promise<{
      combined: { verdict: 'allow' | 'upgrade_to_approval' | 'forbid'; reason?: string; details?: unknown };
      perInspector: ReadonlyArray<{
        inspectorName: string;
        result: { verdict: 'allow' | 'upgrade_to_approval' | 'forbid'; reason?: string; details?: unknown };
      }>;
    }>;
  };
  /**
   * S.6: optional quota service. Consulted AFTER content inspection but
   * BEFORE proposal write / grant check. A `deny` result terminates the
   * gate with `forbidden { reason: 'quota_exhausted:<kind>:<scope>' }`.
   * A `soft_warn` result is logged but does NOT block. When omitted,
   * no quota check runs — byte-identical to today.
   */
  quotaService?: {
    preflight(args: {
      readonly tenantId: string;
      readonly actionClass: string;
      readonly estimatedCostUsdCents?: number;
      readonly blastRadiusUsers?: number;
    }): Promise<
      | { kind: 'allow' }
      | { kind: 'soft_warn'; quotaKind: string; scope: string; window: string; limit: number; consumed: number; resetAt: string }
      | { kind: 'deny';      quotaKind: string; scope: string; window: string; limit: number; consumed: number; resetAt: string }
    >;
  };
  /**
   * S.6: optional cost estimator. When supplied alongside `quotaService`,
   * the gate calls `estimate(...)` and passes the result to
   * `preflight()` so usd_cost_* quotas see a non-zero contribution.
   */
  budgetEstimator?: {
    estimate(args: {
      readonly tenantId: string;
      readonly actionClass: string;
      readonly payload?: unknown;
      readonly homeRegion?: string;
    }): Promise<{ costUsdCents: number; source: string; confidence: string }>;
  };
  /**
   * Audit-fix (T.−1 #1): optional calibration-snapshot verifier. When
   * supplied, gate() verifies `ctx.calibrationSnapshot.sourceSig` before
   * trusting the snapshot's accountAgeDays / per-class scores. A failed
   * verification means a tool constructed a synthetic snapshot — the
   * gate falls back to the most-conservative defaults (accountAgeDays=0,
   * actionClassScores={}) rather than rejecting the action outright, so
   * a bug in the verifier never blocks legitimate work but a successful
   * forgery still gets cold-start treatment.
   *
   * When omitted, no verification runs — byte-identical to today.
   */
  snapshotVerifier?: {
    verify(snapshot: import('@oweibo/core-contracts').TenantReadinessSnapshot): boolean;
  };
}

// ── Service ────────────────────────────────────────────────────────────────

export class ActionTrustLadder implements IActionGate {
  private readonly isEnabled: () => boolean;
  private readonly isShadowOnly: () => boolean;
  private readonly now: () => Date;
  private readonly slaAttacher: ActionTrustLadderOptions['slaAttacher'];
  private readonly rateLimiter: ActionTrustLadderOptions['rateLimiter'];
  private readonly grantChecker: ActionTrustLadderOptions['grantChecker'];
  private readonly grantPrincipalKind: () => 'agent' | 'user';
  private readonly contentInspectors: ActionTrustLadderOptions['contentInspectors'];
  private readonly quotaService: ActionTrustLadderOptions['quotaService'];
  private readonly budgetEstimator: ActionTrustLadderOptions['budgetEstimator'];
  private readonly snapshotVerifier: ActionTrustLadderOptions['snapshotVerifier'];

  constructor(
    private readonly pool: Pool,
    opts: ActionTrustLadderOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.isShadowOnly = opts.isShadowOnly ?? defaultShadowOnly;
    this.now = opts.now ?? (() => new Date());
    this.slaAttacher = opts.slaAttacher;
    this.rateLimiter = opts.rateLimiter;
    this.grantChecker = opts.grantChecker;
    this.grantPrincipalKind = opts.grantPrincipalKind ?? (() => 'agent');
    this.contentInspectors = opts.contentInspectors;
    this.quotaService = opts.quotaService;
    this.budgetEstimator = opts.budgetEstimator;
    this.snapshotVerifier = opts.snapshotVerifier;
  }

  async gate(ctx: ActionContext): Promise<GateDecision> {
    if (!this.isEnabled()) {
      return { mode: 'execute' };
    }

    // Audit-fix (T.−1 #1): verify the calibration snapshot's HMAC before
    // trusting any of its fields. A forged snapshot is degraded to the
    // most-conservative cold-start profile (age 0, no per-class scores),
    // which forces the platform_default matrix to pick the strictest
    // mode for the requested class.
    let effectiveCtx: ActionContext = ctx;
    if (this.snapshotVerifier && !this.snapshotVerifier.verify(ctx.calibrationSnapshot)) {
      effectiveCtx = {
        ...ctx,
        calibrationSnapshot: {
          ...ctx.calibrationSnapshot,
          accountAgeDays: 0,
          actionClassScores: {},
        },
      };
    }

    // S.2: rate-limit check happens BEFORE the trust-mode resolution so
    // bucket-exhausted requests don't pollute action_proposals or burn
    // observation counters. Shadow-only mode bypasses (the action will
    // execute as 'execute' regardless of what the gate says).
    if (this.rateLimiter && !this.isShadowOnly()) {
      const rl = await this.rateLimiter.tryConsume(ctx.tenantId, ctx.actionClass);
      if (rl.kind === 'soft') {
        return { mode: 'rate_limited', retryAfterMs: rl.retryAfterMs };
      }
      if (rl.kind === 'hard') {
        return { mode: 'forbidden', reason: rl.reason };
      }
    }

    // resolveState (and the auto-promote nested inside it) read from the
    // calibration snapshot — pass the effectiveCtx so a failed
    // verification actually downgrades the decision.
    const resolved = await this.resolveState(effectiveCtx);
    const shadowOnly = this.isShadowOnly();

    // S.5.a: content inspectors may upgrade the mode (execute → approval,
    // or any mode → forbidden). They cannot downgrade. Forbid is terminal.
    // Inspector results are persisted for audit regardless of the final
    // decision. Shadow-only bypasses (the action runs as 'execute' anyway,
    // and we don't want to spam audit during the shadow rollout window).
    let effectiveMode: TrustMode = resolved.mode;
    let inspectionForbidReason: string | null = null;
    if (this.contentInspectors && !shadowOnly) {
      const inspection = await this.contentInspectors.run(ctx);
      // Fire-and-forget audit insert; never blocks the decision.
      void this.recordInspectionResults(ctx, inspection.perInspector).catch(() => undefined);
      if (inspection.combined.verdict === 'forbid') {
        inspectionForbidReason = inspection.combined.reason ?? 'content inspection forbade action';
      } else if (inspection.combined.verdict === 'upgrade_to_approval') {
        if (effectiveMode === 'execute' || effectiveMode === 'dry_run' || effectiveMode === 'shadow') {
          effectiveMode = 'require_approval';
        }
      }
    }

    if (inspectionForbidReason !== null) {
      return { mode: 'forbidden', reason: inspectionForbidReason };
    }

    // S.6: quota preflight runs AFTER content inspection and BEFORE the
    // execute/forbidden early returns. A `deny` result terminates the gate
    // with `quota_exhausted:<kind>:<scope>`. A `soft_warn` is logged but
    // does not block. Shadow-only bypasses (the action will execute
    // either way and we don't want to burn quota on shadows).
    if (this.quotaService && !shadowOnly) {
      let estimatedCostUsdCents: number | undefined;
      if (this.budgetEstimator) {
        try {
          const est = await this.budgetEstimator.estimate({
            tenantId: ctx.tenantId,
            actionClass: ctx.actionClass,
            payload: ctx.payload,
          });
          estimatedCostUsdCents = est.costUsdCents;
        } catch {
          // Estimator failure must never block the gate; usd_cost_* quotas
          // simply see 0 contribution and pass through.
        }
      }
      const preflight = await this.quotaService.preflight({
        tenantId: ctx.tenantId,
        actionClass: ctx.actionClass,
        ...(estimatedCostUsdCents !== undefined ? { estimatedCostUsdCents } : {}),
      });
      if (preflight.kind === 'deny') {
        return {
          mode: 'forbidden',
          reason: `quota_exhausted:${preflight.quotaKind}:${preflight.scope}:resets_at_${preflight.resetAt}`,
        };
      }
      // soft_warn: continue. The result is observable via the
      // quota_consumption table; we don't need extra audit here.
    }

    if (effectiveMode === 'execute') {
      return { mode: 'execute' };
    }
    if (effectiveMode === 'forbidden') {
      if (shadowOnly) return { mode: 'execute' };
      return { mode: 'forbidden', reason: 'class is forbidden for this tenant' };
    }

    // S.4: when about to return require_approval, consult any active
    // time-windowed grants. A matching grant short-circuits to execute
    // and records the proposal row tagged with grant_id for audit.
    // Shadow-only mode skips the grant check (the action runs as 'execute'
    // either way, and we don't want to burn grant uses on shadows).
    if (effectiveMode === 'require_approval' && this.grantChecker && !shadowOnly) {
      const principalKind = this.grantPrincipalKind();
      const grant = await this.grantChecker.tryConsume({
        tenantId: ctx.tenantId,
        actionClass: ctx.actionClass,
        grantedToKind: principalKind,
        ...(principalKind === 'user' ? { grantedToUserId: ctx.userId } : {}),
        payload: ctx.payload,
      });
      if (grant.kind === 'grant_consumed') {
        // Record an audit proposal in `executed_live` state with the grant
        // id, so operators can see "this action ran via grant X".
        await this.recordGrantConsumedProposal(ctx, grant.grantId);
        return { mode: 'execute' };
      }
    }

    // dry_run / shadow / require_approval — write a proposal row.
    const proposalId = await this.recordProposal(ctx, effectiveMode);

    // S.1: when a require_approval proposal is recorded, attach an SLA so
    // the lifecycle worker can drive notifications/escalations/expiry.
    // Best-effort — never block the gate path. Skipped in shadow-only mode
    // since the action will execute anyway.
    if (effectiveMode === 'require_approval' && !shadowOnly && this.slaAttacher) {
      try {
        await this.slaAttacher.attachSla(proposalId, ctx.tenantId, ctx.actionClass);
      } catch {
        // SLA attach must never break the gate decision.
      }
    }

    if (shadowOnly) {
      return { mode: 'execute' };
    }
    switch (effectiveMode) {
      case 'dry_run':          return { mode: 'dry_run', proposalId };
      case 'shadow':           return { mode: 'shadow', shadowId: proposalId };
      case 'require_approval': return { mode: 'require_approval', approvalId: proposalId };
    }
    // Unreachable — TS-narrowed by prior checks.
    throw new Error(`unreachable effectiveMode: ${effectiveMode}`);
  }

  async promote(
    promoteId: string,
    principal: GatePrincipal,
    outcome: 'success' | 'failure',
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantScope(client, principal);
      const rows = await client.query<{ tenant_id: string; action_class: string; mode: string; state: string }>(
        `SELECT tenant_id, action_class, mode, state
         FROM oweibo.action_proposals
         WHERE id = $1
         FOR UPDATE`,
        [promoteId],
      );
      const row = rows.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        throw new Error(`ActionTrustLadder.promote: no proposal ${promoteId}`);
      }
      const { tenant_id, action_class, state } = row;
      if (state !== 'pending') {
        await client.query('ROLLBACK');
        throw new Error(`ActionTrustLadder.promote: proposal ${promoteId} already ${state}`);
      }
      const newState = outcome === 'success' ? 'executed_live' : 'rejected';
      await client.query(
        `UPDATE oweibo.action_proposals
            SET state = $2,
                decided_by = $3::uuid,
                decided_at = NOW(),
                decision_reason = $4
          WHERE id = $1`,
        [promoteId, newState, principal.sub, `promote:${outcome}`],
      );
      await bumpObservation(client, tenant_id, action_class, outcome === 'success' ? 'success' : 'failure');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async reject(promoteId: string, principal: GatePrincipal, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantScope(client, principal);
      const rows = await client.query<{ tenant_id: string; action_class: string; state: string }>(
        `SELECT tenant_id, action_class, state
         FROM oweibo.action_proposals
         WHERE id = $1
         FOR UPDATE`,
        [promoteId],
      );
      const row = rows.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        throw new Error(`ActionTrustLadder.reject: no proposal ${promoteId}`);
      }
      const { tenant_id, action_class, state } = row;
      if (state !== 'pending') {
        await client.query('ROLLBACK');
        throw new Error(`ActionTrustLadder.reject: proposal ${promoteId} already ${state}`);
      }
      await client.query(
        `UPDATE oweibo.action_proposals
            SET state = 'rejected',
                decided_by = $2::uuid,
                decided_at = NOW(),
                decision_reason = $3
          WHERE id = $1`,
        [promoteId, principal.sub, reason],
      );
      await bumpObservation(client, tenant_id, action_class, 'rejection');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async resolveState(ctx: ActionContext): Promise<ResolvedState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantScopeFromCtx(client, ctx);
      const rows = await client.query<{
        current_mode: string;
        pinned_by: string | null;
        observations: number;
        successes: number;
      }>(
        `SELECT current_mode, pinned_by, observations, successes
         FROM oweibo.tenant_action_class_state
         WHERE tenant_id = $1::uuid AND action_class = $2`,
        [ctx.tenantId, ctx.actionClass],
      );
      const row = rows.rows[0];
      if (row) {
        const explicit: ResolvedState = {
          mode: row.current_mode as TrustMode,
          fromExplicit: true,
          pinnedBy: row.pinned_by,
          observations: row.observations,
          successes: row.successes,
        };
        const promoted = await tryAutoPromote(client, ctx, explicit);
        await client.query('COMMIT');
        return promoted ?? explicit;
      }
      await client.query('COMMIT');
      return {
        mode: this.platformDefault(ctx),
        fromExplicit: false,
        pinnedBy: null,
        observations: 0,
        successes: 0,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private platformDefault(ctx: ActionContext): TrustMode {
    if (!isCoreActionClass(ctx.actionClass)) {
      // Extended action classes default to require_approval until registered with a policy.
      return 'require_approval';
    }
    const row = PLATFORM_DEFAULTS[ctx.actionClass];
    const age = ctx.calibrationSnapshot.accountAgeDays;
    const score = ctx.calibrationSnapshot.actionClassScores[ctx.actionClass] ?? 0;
    if (age >= 30 && score >= 0.85) return row.established;
    if (age >= 7 && score >= 0.6) return row.withSignal;
    return row.young;
  }

  /**
   * S.5.a: persist the per-inspector audit log. Best-effort; failure
   * MUST NOT affect the gate decision. proposal_id is null when the
   * gate ultimately resolves to execute (no row in action_proposals).
   */
  private async recordInspectionResults(
    ctx: ActionContext,
    perInspector: ReadonlyArray<{
      inspectorName: string;
      result: { verdict: 'allow' | 'upgrade_to_approval' | 'forbid'; reason?: string; details?: unknown };
    }>,
  ): Promise<void> {
    if (perInspector.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantScopeFromCtx(client, ctx);
      for (const p of perInspector) {
        await client.query(
          `INSERT INTO oweibo.content_inspection_results
             (tenant_id, action_class, action_id, inspector_name, verdict, reason, details)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            ctx.tenantId,
            ctx.actionClass,
            ctx.actionId,
            p.inspectorName,
            p.result.verdict,
            p.result.reason ?? null,
            p.result.details !== undefined ? JSON.stringify(p.result.details) : null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * S.4: when a grant short-circuits require_approval → execute, we still
   * write a proposal row so the action appears in audit. The row is
   * recorded directly as executed_live and tagged with grant_id so
   * operators can group actions by the grant that authorized them. This
   * is fire-and-forget — failure to insert MUST NOT block the action.
   */
  private async recordGrantConsumedProposal(ctx: ActionContext, grantId: string): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await setTenantScopeFromCtx(client, ctx);
        await client.query(
          `INSERT INTO oweibo.action_proposals (
             id, tenant_id, user_id, action_class, action_id, mode,
             summary, payload, rollback_kind, rollback_detail, state,
             created_at, expires_at, grant_id, decided_at, decision_reason
           ) VALUES (
             gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, 'require_approval',
             $5, $6::jsonb, $7, $8::jsonb, 'executed_live',
             NOW(), NOW() + INTERVAL '7 days', $9::uuid, NOW(), 'auto_promoted_via_grant'
           )
           ON CONFLICT (tenant_id, action_id) DO NOTHING`,
          [
            ctx.tenantId,
            ctx.userId,
            ctx.actionClass,
            ctx.actionId,
            ctx.summary,
            JSON.stringify(ctx.payload ?? null),
            ctx.rollback?.kind ?? null,
            JSON.stringify(ctx.rollback?.rollbackPlan ?? null),
            grantId,
          ],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch {
      // Audit-row failure must never block the action that the grant
      // already authorized.
    }
  }

  private async recordProposal(ctx: ActionContext, mode: TrustMode): Promise<string> {
    if (mode === 'execute' || mode === 'forbidden') {
      throw new Error(`recordProposal: not a proposal mode: ${mode}`);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantScopeFromCtx(client, ctx);
      // ON CONFLICT (tenant_id, action_id) DO NOTHING — same actionId is never doubled.
      const result = await client.query<{ id: string }>(
        `INSERT INTO oweibo.action_proposals (
           id, tenant_id, user_id, action_class, action_id, mode,
           summary, payload, rollback_kind, rollback_detail, state,
           created_at, expires_at
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5,
           $6, $7::jsonb, $8, $9::jsonb, 'pending',
           NOW(), NOW() + INTERVAL '7 days'
         )
         ON CONFLICT (tenant_id, action_id) DO UPDATE SET action_id = EXCLUDED.action_id
         RETURNING id`,
        [
          ctx.tenantId,
          ctx.userId,
          ctx.actionClass,
          ctx.actionId,
          mode,
          ctx.summary,
          JSON.stringify(ctx.payload ?? null),
          ctx.rollback?.kind ?? null,
          JSON.stringify(ctx.rollback?.rollbackPlan ?? null),
        ],
      );
      await client.query('COMMIT');
      const idRow = result.rows[0];
      if (!idRow) throw new Error('recordProposal: insert returned no id');
      return idRow.id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function defaultEnabled(): boolean {
  return process.env.ACTION_TRUST_LADDER_ENABLED === 'true';
}

function defaultShadowOnly(): boolean {
  return process.env.ACTION_TRUST_LADDER_SHADOW_ONLY === 'true';
}

async function setTenantScope(client: PoolClient, principal: GatePrincipal): Promise<void> {
  const tenantId = principal.ctx.tenantId ?? '';
  if (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId)) {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  }
  if (principal.scopes.includes('platform:tenants:write')) {
    await client.query(`SET LOCAL ROLE platform_admin`);
  }
}

async function setTenantScopeFromCtx(client: PoolClient, ctx: ActionContext): Promise<void> {
  if (/^[0-9a-f-]{36}$/i.test(ctx.tenantId)) {
    await client.query(`SET LOCAL app.tenant_id = '${ctx.tenantId}'`);
  }
}

type ObservationOutcome = 'success' | 'failure' | 'rejection';

async function bumpObservation(
  client: PoolClient,
  tenantId: string,
  actionClass: string,
  outcome: ObservationOutcome,
): Promise<void> {
  const successDelta = outcome === 'success' ? 1 : 0;
  const rejectionDelta = outcome === 'rejection' || outcome === 'failure' ? 1 : 0;
  await client.query(
    `INSERT INTO oweibo.tenant_action_class_state (
       tenant_id, action_class, current_mode, observations, successes, rejections, last_updated
     ) VALUES (
       $1::uuid, $2, 'dry_run', 1, $3, $4, NOW()
     )
     ON CONFLICT (tenant_id, action_class) DO UPDATE
       SET observations = oweibo.tenant_action_class_state.observations + 1,
           successes    = oweibo.tenant_action_class_state.successes    + EXCLUDED.successes,
           rejections   = oweibo.tenant_action_class_state.rejections   + EXCLUDED.rejections,
           last_updated = NOW()`,
    [tenantId, actionClass, successDelta, rejectionDelta],
  );
}

async function tryAutoPromote(
  client: PoolClient,
  ctx: ActionContext,
  state: ResolvedState,
): Promise<ResolvedState | null> {
  if (state.mode !== 'dry_run') return null;
  if (state.pinnedBy) return null;
  if (ctx.calibrationSnapshot.accountAgeDays < AUTO_PROMOTE_MIN_AGE_DAYS) return null;
  if (state.observations < AUTO_PROMOTE_MIN_OBS) return null;
  if (state.observations === 0) return null;
  const rate = state.successes / state.observations;
  if (rate < AUTO_PROMOTE_MIN_RATE) return null;
  if (isCoreActionClass(ctx.actionClass) && CLASSES_ALWAYS_REQUIRE_APPROVAL.has(ctx.actionClass)) {
    return null;
  }
  // Atomic compare-and-set: only promote if the row is still in dry_run
  // and still unpinned. Zero rows back ⇒ a concurrent gate() already
  // promoted (or the row was just pinned by an operator); we observe
  // the new state on the next gate() rather than racing the UPDATE.
  const result = await client.query<{ id: string }>(
    `UPDATE oweibo.tenant_action_class_state
        SET current_mode = 'execute', last_updated = NOW()
      WHERE tenant_id = $1::uuid
        AND action_class = $2
        AND current_mode = 'dry_run'
        AND pinned_by IS NULL
      RETURNING tenant_id AS id`,
    [ctx.tenantId, ctx.actionClass],
  );
  if (result.rows.length === 0) return null;
  return { ...state, mode: 'execute' };
}

/** Helper used by callers to construct a deterministic actionId from inputs. */
export function deriveActionId(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const p of parts) hash.update(p).update(' ');
  return hash.digest('hex').slice(0, 32);
}

/** Convenience: a randomly-generated actionId for one-off calls. */
export function randomActionId(): string {
  return randomUUID();
}
