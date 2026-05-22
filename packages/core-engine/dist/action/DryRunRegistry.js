"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DryRunRegistry = void 0;
class DryRunRegistry {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /** List proposals visible to the principal's tenant. */
    async list(principal, filters = {}) {
        const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
        const states = filters.state && filters.state.length > 0 ? filters.state : ['pending'];
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setScope(client, principal);
            const params = [states];
            let where = `state = ANY($1::text[])`;
            if (filters.actionClass) {
                params.push(filters.actionClass);
                where += ` AND action_class = $${params.length}`;
            }
            if (filters.beforeCreatedAt) {
                params.push(filters.beforeCreatedAt);
                where += ` AND created_at < $${params.length}::timestamptz`;
            }
            params.push(limit);
            const sql = `
        SELECT id, tenant_id, user_id, action_class, action_id, mode, summary,
               rollback_kind, state, created_at, expires_at, decided_at,
               decided_by, decision_reason
          FROM oweibo.action_proposals
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`;
            const result = await client.query(sql, params);
            await client.query('COMMIT');
            return result.rows.map(toSummary);
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
    /** Fetch a single proposal including its full payload and rollback detail. */
    async get(principal, proposalId) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setScope(client, principal);
            const result = await client.query(`SELECT id, tenant_id, user_id, action_class, action_id, mode, summary,
                rollback_kind, rollback_detail, payload, state, created_at,
                expires_at, decided_at, decided_by, decision_reason
           FROM oweibo.action_proposals
          WHERE id = $1`, [proposalId]);
            await client.query('COMMIT');
            if (result.rowCount === 0)
                return null;
            const row = result.rows[0];
            return {
                ...toSummary(row),
                payload: row.payload,
                rollbackDetail: row.rollback_detail,
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
    /** Read the per-(tenant, class) trust matrix. Includes only explicit rows. */
    async listTrustMatrix(principal) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setScope(client, principal);
            const result = await client.query(`SELECT action_class, current_mode, pinned_by, pinned_reason,
                observations, successes, rejections, last_updated
           FROM oweibo.tenant_action_class_state
          ORDER BY action_class`);
            await client.query('COMMIT');
            return result.rows.map((r) => ({
                actionClass: r.action_class,
                currentMode: r.current_mode,
                pinnedBy: r.pinned_by,
                pinnedReason: r.pinned_reason,
                observations: r.observations,
                successes: r.successes,
                rejections: r.rejections,
                lastUpdated: typeof r.last_updated === 'string' ? r.last_updated : r.last_updated.toISOString(),
            }));
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        }
        finally {
            client.release();
        }
    }
    /** Pin a class to a specific mode. Pinned classes do not auto-promote. */
    async pin(principal, actionClass, mode, reason) {
        const tenantId = principal.ctx.tenantId ?? '';
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setScope(client, principal);
            await client.query(`INSERT INTO oweibo.tenant_action_class_state (
           tenant_id, action_class, current_mode, pinned_by, pinned_reason, last_updated
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, NOW()
         )
         ON CONFLICT (tenant_id, action_class) DO UPDATE
           SET current_mode  = EXCLUDED.current_mode,
               pinned_by     = EXCLUDED.pinned_by,
               pinned_reason = EXCLUDED.pinned_reason,
               last_updated  = NOW()`, [tenantId, actionClass, mode, principal.sub, reason]);
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
    /** Remove an operator pin. State row is preserved so observation counters survive. */
    async unpin(principal, actionClass) {
        const tenantId = principal.ctx.tenantId ?? '';
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await setScope(client, principal);
            await client.query(`UPDATE oweibo.tenant_action_class_state
            SET pinned_by = NULL, pinned_reason = NULL, last_updated = NOW()
          WHERE tenant_id = $1::uuid AND action_class = $2`, [tenantId, actionClass]);
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
exports.DryRunRegistry = DryRunRegistry;
function toSummary(row) {
    const asString = (v) => {
        if (v === null || v === undefined)
            return null;
        if (typeof v === 'string')
            return v;
        if (v instanceof Date)
            return v.toISOString();
        return String(v);
    };
    return {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        userId: asString(row.user_id),
        actionClass: String(row.action_class),
        actionId: String(row.action_id),
        mode: row.mode,
        summary: String(row.summary),
        rollbackKind: row.rollback_kind ?? null,
        state: row.state,
        createdAt: asString(row.created_at) ?? '',
        expiresAt: asString(row.expires_at) ?? '',
        decidedAt: asString(row.decided_at),
        decidedBy: asString(row.decided_by),
        decisionReason: asString(row.decision_reason),
    };
}
async function setScope(client, principal) {
    const tenantId = principal.ctx.tenantId ?? '';
    if (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    }
    if (principal.scopes.includes('platform:tenants:write')) {
        await client.query(`SET LOCAL ROLE platform_admin`);
    }
}
//# sourceMappingURL=DryRunRegistry.js.map