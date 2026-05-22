"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShadowExecutor = void 0;
class ShadowExecutor {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /**
     * Record a shadow execution outcome.
     *
     * Per the plan's observation accounting:
     *   - shadow succeeds AND parity == 'parity' → +1 observation, +1 success
     *   - shadow succeeds AND parity == 'drift'  → +1 observation, +1 rejection
     *   - shadow fails                           → +1 observation, +1 rejection
     *   - parity == 'unknown'                    → +1 observation only
     */
    async recordOutcome(principal, outcome) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setScope(client, principal);
            const rows = await client.query(`SELECT tenant_id, action_class, state
           FROM oweibo.action_proposals
          WHERE id = $1
          FOR UPDATE`, [outcome.proposalId]);
            const row = rows.rows[0];
            if (!row) {
                await client.query('ROLLBACK');
                throw new Error(`ShadowExecutor.recordOutcome: no proposal ${outcome.proposalId}`);
            }
            const { tenant_id, action_class, state } = row;
            if (state !== 'pending') {
                await client.query('ROLLBACK');
                throw new Error(`ShadowExecutor.recordOutcome: proposal ${outcome.proposalId} already ${state}`);
            }
            const decisionReason = outcome.reason
                ? `shadow:${outcome.success ? 'success' : 'failure'}:${outcome.parity}:${outcome.reason}`
                : `shadow:${outcome.success ? 'success' : 'failure'}:${outcome.parity}`;
            const payload = outcome.diff !== undefined
                ? JSON.stringify({ diff: outcome.diff, parity: outcome.parity })
                : JSON.stringify({ parity: outcome.parity });
            await client.query(`UPDATE oweibo.action_proposals
            SET state           = 'executed_shadow',
                decided_by      = $2::uuid,
                decided_at      = NOW(),
                decision_reason = $3,
                rollback_detail = COALESCE(rollback_detail, '{}'::jsonb) || $4::jsonb
          WHERE id = $1`, [outcome.proposalId, principal.sub, decisionReason, payload]);
            // Observation accounting — see plan T.−1 §observation table.
            const successDelta = outcome.success && outcome.parity === 'parity' ? 1 : 0;
            const rejectionDelta = !outcome.success || outcome.parity === 'drift' ? 1 : 0;
            const recordObservation = outcome.parity !== 'unknown';
            if (recordObservation) {
                await client.query(`INSERT INTO oweibo.tenant_action_class_state (
             tenant_id, action_class, current_mode, observations, successes, rejections, last_updated
           ) VALUES (
             $1::uuid, $2, 'shadow', 1, $3, $4, NOW()
           )
           ON CONFLICT (tenant_id, action_class) DO UPDATE
             SET observations = oweibo.tenant_action_class_state.observations + 1,
                 successes    = oweibo.tenant_action_class_state.successes    + EXCLUDED.successes,
                 rejections   = oweibo.tenant_action_class_state.rejections   + EXCLUDED.rejections,
                 last_updated = NOW()`, [tenant_id, action_class, successDelta, rejectionDelta]);
            }
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
}
exports.ShadowExecutor = ShadowExecutor;
async function setScope(client, principal) {
    const tenantId = principal.ctx.tenantId ?? '';
    if (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    }
    if (principal.scopes.includes('platform:tenants:write')) {
        await client.query(`SET LOCAL ROLE platform_admin`);
    }
}
//# sourceMappingURL=ShadowExecutor.js.map