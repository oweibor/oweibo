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
}

// ── Service ────────────────────────────────────────────────────────────────

export class ActionTrustLadder implements IActionGate {
  private readonly isEnabled: () => boolean;
  private readonly isShadowOnly: () => boolean;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    opts: ActionTrustLadderOptions = {},
  ) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.isShadowOnly = opts.isShadowOnly ?? defaultShadowOnly;
    this.now = opts.now ?? (() => new Date());
  }

  async gate(ctx: ActionContext): Promise<GateDecision> {
    if (!this.isEnabled()) {
      return { mode: 'execute' };
    }

    const resolved = await this.resolveState(ctx);
    const shadowOnly = this.isShadowOnly();

    if (resolved.mode === 'execute') {
      return { mode: 'execute' };
    }
    if (resolved.mode === 'forbidden') {
      if (shadowOnly) return { mode: 'execute' };
      return { mode: 'forbidden', reason: 'class is forbidden for this tenant' };
    }

    // dry_run / shadow / require_approval — write a proposal row.
    const proposalId = await this.recordProposal(ctx, resolved.mode);

    if (shadowOnly) {
      return { mode: 'execute' };
    }
    switch (resolved.mode) {
      case 'dry_run':          return { mode: 'dry_run', proposalId };
      case 'shadow':           return { mode: 'shadow', shadowId: proposalId };
      case 'require_approval': return { mode: 'require_approval', approvalId: proposalId };
    }
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
  await client.query(
    `UPDATE oweibo.tenant_action_class_state
        SET current_mode = 'execute', last_updated = NOW()
      WHERE tenant_id = $1::uuid AND action_class = $2 AND pinned_by IS NULL`,
    [ctx.tenantId, ctx.actionClass],
  );
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
