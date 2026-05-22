"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionTrustLadder = void 0;
exports.deriveActionId = deriveActionId;
exports.randomActionId = randomActionId;
const crypto_1 = require("crypto");
const core_contracts_1 = require("@oweibo/core-contracts");
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
const CLASSES_ALWAYS_REQUIRE_APPROVAL = new Set([
    'financial.payment',
    'personnel.access_grant',
    'personnel.access_revoke',
    'irreversible.delete_resource',
    'irreversible.public_publish',
]);
const PLATFORM_DEFAULTS = {
    'read.local': { young: 'execute', withSignal: 'execute', established: 'execute' },
    'read.external_api': { young: 'execute', withSignal: 'execute', established: 'execute' },
    'read.tenant_db': { young: 'execute', withSignal: 'execute', established: 'execute' },
    'write.local.scratch': { young: 'execute', withSignal: 'execute', established: 'execute' },
    'write.local.repo_nonprod': { young: 'dry_run', withSignal: 'execute', established: 'execute' },
    'write.local.repo_prod': { young: 'require_approval', withSignal: 'require_approval', established: 'execute' },
    'write.external_api.nonprod': { young: 'dry_run', withSignal: 'shadow', established: 'execute' },
    'write.external_api.prod': { young: 'require_approval', withSignal: 'require_approval', established: 'execute' },
    'write.tenant_db.nonprod': { young: 'dry_run', withSignal: 'shadow', established: 'execute' },
    'write.tenant_db.prod': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
    'comm.internal': { young: 'dry_run', withSignal: 'execute', established: 'execute' },
    'comm.external_email': { young: 'require_approval', withSignal: 'dry_run', established: 'execute' },
    'comm.external_message': { young: 'require_approval', withSignal: 'dry_run', established: 'execute' },
    'financial.payment': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
    'personnel.access_grant': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
    'personnel.access_revoke': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
    'irreversible.delete_resource': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
    'irreversible.public_publish': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
    'deploy.nonprod': { young: 'dry_run', withSignal: 'execute', established: 'execute' },
    'deploy.prod': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
    'unclassified': { young: 'require_approval', withSignal: 'require_approval', established: 'require_approval' },
};
// ── Auto-promotion thresholds ──────────────────────────────────────────────
const AUTO_PROMOTE_MIN_OBS = 10;
const AUTO_PROMOTE_MIN_RATE = 0.95;
const AUTO_PROMOTE_MIN_AGE_DAYS = 7;
// ── Service ────────────────────────────────────────────────────────────────
class ActionTrustLadder {
    pool;
    isEnabled;
    isShadowOnly;
    now;
    constructor(pool, opts = {}) {
        this.pool = pool;
        this.isEnabled = opts.isEnabled ?? defaultEnabled;
        this.isShadowOnly = opts.isShadowOnly ?? defaultShadowOnly;
        this.now = opts.now ?? (() => new Date());
    }
    async gate(ctx) {
        if (!this.isEnabled()) {
            return { mode: 'execute' };
        }
        const resolved = await this.resolveState(ctx);
        const shadowOnly = this.isShadowOnly();
        if (resolved.mode === 'execute') {
            return { mode: 'execute' };
        }
        if (resolved.mode === 'forbidden') {
            if (shadowOnly)
                return { mode: 'execute' };
            return { mode: 'forbidden', reason: 'class is forbidden for this tenant' };
        }
        // dry_run / shadow / require_approval — write a proposal row.
        const proposalId = await this.recordProposal(ctx, resolved.mode);
        if (shadowOnly) {
            return { mode: 'execute' };
        }
        switch (resolved.mode) {
            case 'dry_run': return { mode: 'dry_run', proposalId };
            case 'shadow': return { mode: 'shadow', shadowId: proposalId };
            case 'require_approval': return { mode: 'require_approval', approvalId: proposalId };
        }
    }
    async promote(promoteId, principal, outcome) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setTenantScope(client, principal);
            const rows = await client.query(`SELECT tenant_id, action_class, mode, state
         FROM oweibo.action_proposals
         WHERE id = $1
         FOR UPDATE`, [promoteId]);
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
            await client.query(`UPDATE oweibo.action_proposals
            SET state = $2,
                decided_by = $3::uuid,
                decided_at = NOW(),
                decision_reason = $4
          WHERE id = $1`, [promoteId, newState, principal.sub, `promote:${outcome}`]);
            await bumpObservation(client, tenant_id, action_class, outcome === 'success' ? 'success' : 'failure');
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
    async reject(promoteId, principal, reason) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setTenantScope(client, principal);
            const rows = await client.query(`SELECT tenant_id, action_class, state
         FROM oweibo.action_proposals
         WHERE id = $1
         FOR UPDATE`, [promoteId]);
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
            await client.query(`UPDATE oweibo.action_proposals
            SET state = 'rejected',
                decided_by = $2::uuid,
                decided_at = NOW(),
                decision_reason = $3
          WHERE id = $1`, [promoteId, principal.sub, reason]);
            await bumpObservation(client, tenant_id, action_class, 'rejection');
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
    // ── Internals ───────────────────────────────────────────────────────────
    async resolveState(ctx) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setTenantScopeFromCtx(client, ctx);
            const rows = await client.query(`SELECT current_mode, pinned_by, observations, successes
         FROM oweibo.tenant_action_class_state
         WHERE tenant_id = $1::uuid AND action_class = $2`, [ctx.tenantId, ctx.actionClass]);
            const row = rows.rows[0];
            if (row) {
                const explicit = {
                    mode: row.current_mode,
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
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
    platformDefault(ctx) {
        if (!(0, core_contracts_1.isCoreActionClass)(ctx.actionClass)) {
            // Extended action classes default to require_approval until registered with a policy.
            return 'require_approval';
        }
        const row = PLATFORM_DEFAULTS[ctx.actionClass];
        const age = ctx.calibrationSnapshot.accountAgeDays;
        const score = ctx.calibrationSnapshot.actionClassScores[ctx.actionClass] ?? 0;
        if (age >= 30 && score >= 0.85)
            return row.established;
        if (age >= 7 && score >= 0.6)
            return row.withSignal;
        return row.young;
    }
    async recordProposal(ctx, mode) {
        if (mode === 'execute' || mode === 'forbidden') {
            throw new Error(`recordProposal: not a proposal mode: ${mode}`);
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setTenantScopeFromCtx(client, ctx);
            // ON CONFLICT (tenant_id, action_id) DO NOTHING — same actionId is never doubled.
            const result = await client.query(`INSERT INTO oweibo.action_proposals (
           id, tenant_id, user_id, action_class, action_id, mode,
           summary, payload, rollback_kind, rollback_detail, state,
           created_at, expires_at
         ) VALUES (
           gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5,
           $6, $7::jsonb, $8, $9::jsonb, 'pending',
           NOW(), NOW() + INTERVAL '7 days'
         )
         ON CONFLICT (tenant_id, action_id) DO UPDATE SET action_id = EXCLUDED.action_id
         RETURNING id`, [
                ctx.tenantId,
                ctx.userId,
                ctx.actionClass,
                ctx.actionId,
                mode,
                ctx.summary,
                JSON.stringify(ctx.payload ?? null),
                ctx.rollback?.kind ?? null,
                JSON.stringify(ctx.rollback?.rollbackPlan ?? null),
            ]);
            await client.query('COMMIT');
            const idRow = result.rows[0];
            if (!idRow)
                throw new Error('recordProposal: insert returned no id');
            return idRow.id;
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
}
exports.ActionTrustLadder = ActionTrustLadder;
// ── Helpers ────────────────────────────────────────────────────────────────
function defaultEnabled() {
    return process.env.ACTION_TRUST_LADDER_ENABLED === 'true';
}
function defaultShadowOnly() {
    return process.env.ACTION_TRUST_LADDER_SHADOW_ONLY === 'true';
}
async function setTenantScope(client, principal) {
    const tenantId = principal.ctx.tenantId ?? '';
    if (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    }
    if (principal.scopes.includes('platform:tenants:write')) {
        await client.query(`SET LOCAL ROLE platform_admin`);
    }
}
async function setTenantScopeFromCtx(client, ctx) {
    if (/^[0-9a-f-]{36}$/i.test(ctx.tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${ctx.tenantId}'`);
    }
}
async function bumpObservation(client, tenantId, actionClass, outcome) {
    const successDelta = outcome === 'success' ? 1 : 0;
    const rejectionDelta = outcome === 'rejection' || outcome === 'failure' ? 1 : 0;
    await client.query(`INSERT INTO oweibo.tenant_action_class_state (
       tenant_id, action_class, current_mode, observations, successes, rejections, last_updated
     ) VALUES (
       $1::uuid, $2, 'dry_run', 1, $3, $4, NOW()
     )
     ON CONFLICT (tenant_id, action_class) DO UPDATE
       SET observations = oweibo.tenant_action_class_state.observations + 1,
           successes    = oweibo.tenant_action_class_state.successes    + EXCLUDED.successes,
           rejections   = oweibo.tenant_action_class_state.rejections   + EXCLUDED.rejections,
           last_updated = NOW()`, [tenantId, actionClass, successDelta, rejectionDelta]);
}
async function tryAutoPromote(client, ctx, state) {
    if (state.mode !== 'dry_run')
        return null;
    if (state.pinnedBy)
        return null;
    if (ctx.calibrationSnapshot.accountAgeDays < AUTO_PROMOTE_MIN_AGE_DAYS)
        return null;
    if (state.observations < AUTO_PROMOTE_MIN_OBS)
        return null;
    if (state.observations === 0)
        return null;
    const rate = state.successes / state.observations;
    if (rate < AUTO_PROMOTE_MIN_RATE)
        return null;
    if ((0, core_contracts_1.isCoreActionClass)(ctx.actionClass) && CLASSES_ALWAYS_REQUIRE_APPROVAL.has(ctx.actionClass)) {
        return null;
    }
    await client.query(`UPDATE oweibo.tenant_action_class_state
        SET current_mode = 'execute', last_updated = NOW()
      WHERE tenant_id = $1::uuid AND action_class = $2 AND pinned_by IS NULL`, [ctx.tenantId, ctx.actionClass]);
    return { ...state, mode: 'execute' };
}
/** Helper used by callers to construct a deterministic actionId from inputs. */
function deriveActionId(parts) {
    const hash = (0, crypto_1.createHash)('sha256');
    for (const p of parts)
        hash.update(p).update(' ');
    return hash.digest('hex').slice(0, 32);
}
/** Convenience: a randomly-generated actionId for one-off calls. */
function randomActionId() {
    return (0, crypto_1.randomUUID)();
}
//# sourceMappingURL=ActionTrustLadder.js.map