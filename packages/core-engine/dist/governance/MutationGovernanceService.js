"use strict";
// D.12 — MutationGovernanceService: freeze/guard/unfreeze prompt slots.
// Mirrors scripts/platform-prompts.js logic, exposed for the admin-web UI
// at /(platform)/prompts/mutations.
//
// mutation_status semantics (§7.4.3):
//   - 'mutable' — GEPA may produce new candidates; bandits explore freely
//   - 'guarded' — GEPA may produce candidates, but rollout requires
//                 explicit human approval (no auto-promotion)
//   - 'frozen'  — slot is locked at stable-v0; GEPA must not propose
//                 candidates; freeze requires an RFC URL
Object.defineProperty(exports, "__esModule", { value: true });
exports.MutationGovernanceService = void 0;
class MutationGovernanceService {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /** List every distinct (slot_id, role) with current status + last-change metadata. */
    async listSlots(filter) {
        const conditions = [];
        const params = [];
        if (filter?.role) {
            conditions.push(`pv.role = $${params.length + 1}`);
            params.push(filter.role);
        }
        if (filter?.status) {
            conditions.push(`pv.mutation_status = $${params.length + 1}`);
            params.push(filter.status);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        // For each distinct (slot_id, role), grab the canonical mutation_status
        // (every version of a slot shares it) plus the latest history row.
        const result = await this.pool.query(`SELECT DISTINCT ON (pv.slot_id, pv.role)
              pv.slot_id, pv.role, pv.mutation_status, pv.freeze_reason,
              h.changed_at AS last_changed_at,
              h.changed_by AS last_changed_by,
              h.rfc_url    AS last_rfc_url
       FROM oweibo.prompt_versions pv
       LEFT JOIN LATERAL (
         SELECT changed_at, changed_by, rfc_url
         FROM oweibo.prompt_slot_mutation_history
         WHERE slot_id = pv.slot_id AND role = pv.role
         ORDER BY changed_at DESC LIMIT 1
       ) h ON TRUE
       ${where}
       ORDER BY pv.slot_id, pv.role, pv.created_at DESC`, params);
        return result.rows.map(r => ({
            slotId: r.slot_id,
            role: r.role,
            mutationStatus: r.mutation_status,
            freezeReason: r.freeze_reason,
            lastChangedAt: r.last_changed_at,
            lastChangedBy: r.last_changed_by,
            lastRfcUrl: r.last_rfc_url,
        }));
    }
    /** Full status-change history for one slot, newest first. */
    async getHistory(slotId, role, limit = 50) {
        const result = await this.pool.query(`SELECT id, slot_id, role, previous_status, new_status,
              reason, rfc_url, changed_by, changed_at
       FROM oweibo.prompt_slot_mutation_history
       WHERE slot_id = $1 AND role = $2
       ORDER BY changed_at DESC
       LIMIT $3`, [slotId, role, limit]);
        return result.rows.map(r => ({
            id: r.id,
            slotId: r.slot_id,
            role: r.role,
            previousStatus: r.previous_status,
            newStatus: r.new_status,
            reason: r.reason,
            rfcUrl: r.rfc_url,
            changedBy: r.changed_by,
            changedAt: r.changed_at,
        }));
    }
    /**
     * Change mutation_status for every version of a (slot, role) and write a
     * history row. Atomic. Mirrors scripts/platform-prompts.js setStatus().
     */
    async setStatus(input) {
        if (input.newStatus === 'frozen' && !input.rfcUrl) {
            return {
                ok: false,
                error: 'rfc_required',
                message: "Freezing a slot requires an RFC URL (--rfc on the CLI; 'rfcUrl' in the request body).",
            };
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const curRes = await client.query(`SELECT mutation_status
         FROM oweibo.prompt_versions
         WHERE slot_id = $1 AND role = $2
         ORDER BY created_at DESC LIMIT 1`, [input.slotId, input.role]);
            if (curRes.rowCount === 0) {
                await client.query('ROLLBACK');
                return {
                    ok: false,
                    error: 'slot_not_found',
                    message: `No prompt_versions exist for slot=${input.slotId} role=${input.role}.`,
                };
            }
            const previousStatus = curRes.rows[0].mutation_status;
            if (previousStatus === input.newStatus) {
                await client.query('ROLLBACK');
                return {
                    ok: false,
                    error: 'no_change',
                    message: `Slot is already ${input.newStatus}.`,
                };
            }
            const updateRes = await client.query(`UPDATE oweibo.prompt_versions
         SET mutation_status = $1,
             freeze_reason   = $2
         WHERE slot_id = $3 AND role = $4`, [
                input.newStatus,
                input.newStatus !== 'mutable' ? input.reason : null,
                input.slotId,
                input.role,
            ]);
            await client.query(`INSERT INTO oweibo.prompt_slot_mutation_history
           (slot_id, role, previous_status, new_status, reason, rfc_url, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
                input.slotId, input.role, previousStatus, input.newStatus,
                input.reason, input.rfcUrl ?? null, input.changedBy,
            ]);
            await client.query('COMMIT');
            return { ok: true, previousStatus, rowsUpdated: updateRes.rowCount ?? 0 };
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
}
exports.MutationGovernanceService = MutationGovernanceService;
//# sourceMappingURL=MutationGovernanceService.js.map