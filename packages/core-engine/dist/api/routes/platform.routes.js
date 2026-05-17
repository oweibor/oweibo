"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPlatformRouter = createPlatformRouter;
/**
 * platform.routes.ts — Platform governance routes (§17.5.1, §18.8.3, §9.5, §7.4.3, §9.2).
 *
 * GET  /platform/operational-mode               — current mode state + transition history
 * POST /platform/operational-mode               — set mode (platform:admin)
 * GET  /platform/charter/thresholds             — current drift threshold config + recent events
 * POST /platform/charter/thresholds             — update thresholds (platform:admin)
 * GET  /platform/promotions/pending             — list arms awaiting human approval (D.6)
 * GET  /platform/promotions/recent              — recent approve/reject history (D.6)
 * POST /platform/promotions/decide              — approve or reject a promotion (platform:admin)
 * GET  /platform/prompts/mutations              — list slots with mutation_status (D.12)
 * GET  /platform/prompts/mutations/:slot/:role  — full mutation history for one slot
 * POST /platform/prompts/mutations              — change mutation_status (platform:admin)
 * GET  /platform/cohorts/tenants                — list every tenant with cohort_channel (D.1)
 * GET  /platform/cohorts/channels               — available channel names
 * GET  /platform/cohorts/recent                 — recent cohort changes
 * POST /platform/cohorts/tenants/:tenantId      — change a tenant's cohort (platform:admin)
 *
 * Scope guard: POST endpoints require 'platform:admin' in the JWT scopes claim.
 * If scopes are absent (older tokens), fall back to PLATFORM_ADMIN_KEY header.
 */
const express_1 = require("express");
const zod_1 = require("zod");
const OperationalModeService_js_1 = require("../../infrastructure/OperationalModeService.js");
// ── Scope guard ───────────────────────────────────────────────────────────────
const PLATFORM_ADMIN_KEY = process.env['PLATFORM_ADMIN_KEY'];
function requirePlatformAdmin(req, res, next) {
    // Prefer scope-based check (identity-service tokens include scopes[])
    if (req.scopes.includes('platform:admin')) {
        next();
        return;
    }
    // Fallback: shared secret header for internal service-to-service calls
    if (PLATFORM_ADMIN_KEY && req.headers['x-platform-admin-key'] === PLATFORM_ADMIN_KEY) {
        next();
        return;
    }
    res.status(403).json({
        error: 'forbidden',
        message: "Requires 'platform:admin' scope or x-platform-admin-key header.",
    });
}
// ── Request schemas ───────────────────────────────────────────────────────────
const SetModeSchema = zod_1.z.object({
    mode: zod_1.z.number().int().min(0).max(5),
    reason: zod_1.z.string().min(1).max(1000),
    autoTrigger: zod_1.z.string().optional(),
});
const SetThresholdsSchema = zod_1.z.object({
    threshold_7d: zod_1.z.number().gt(0).lt(1),
    threshold_30d: zod_1.z.number().gt(0).lt(1),
    threshold_90d: zod_1.z.number().gt(0).lt(1),
    threshold_vs_v0: zod_1.z.number().gt(0).lt(1),
    reason: zod_1.z.string().min(1).max(1000),
    changedBy: zod_1.z.string().optional(),
});
const PromotionDecisionSchema = zod_1.z.object({
    armId: zod_1.z.string().min(1).max(200),
    slotId: zod_1.z.string().min(1).max(100),
    role: zod_1.z.enum(['architect', 'executor', 'reviewer', 'decomposer']),
    promptHash: zod_1.z.string().min(1).max(200),
    fromChannel: zod_1.z.string().min(1).max(100),
    toChannel: zod_1.z.string().min(1).max(100),
    decision: zod_1.z.enum(['approved', 'rejected']),
    reason: zod_1.z.string().min(1).max(1000),
});
const SetMutationStatusSchema = zod_1.z.object({
    slotId: zod_1.z.string().min(1).max(100),
    role: zod_1.z.string().min(1).max(50),
    newStatus: zod_1.z.enum(['mutable', 'guarded', 'frozen']),
    reason: zod_1.z.string().min(1).max(1000),
    rfcUrl: zod_1.z.string().url().max(500).optional(),
});
const SetTenantCohortSchema = zod_1.z.object({
    newChannel: zod_1.z.string().min(1).max(100),
    reason: zod_1.z.string().min(1).max(1000),
});
// ── Router factory ────────────────────────────────────────────────────────────
function createPlatformRouter(deps) {
    const router = (0, express_1.Router)();
    const { pool, operationalMode, promotionGate, mutationGovernance, cohortAdmin } = deps;
    // ── GET /platform/operational-mode ────────────────────────────────────────
    router.get('/operational-mode', async (_req, res) => {
        const state = await operationalMode.getModeState();
        const history = await operationalMode.getTransitionHistory(20);
        if (!state) {
            res.json({
                currentMode: 5,
                modeName: OperationalModeService_js_1.MODE_NAMES[5],
                setBy: 'unknown',
                setAt: new Date().toISOString(),
                reason: 'No mode record found — defaulting to full operation',
                autoTrigger: null,
                history: [],
            });
            return;
        }
        res.json({
            currentMode: state.currentMode,
            modeName: OperationalModeService_js_1.MODE_NAMES[state.currentMode],
            setBy: state.setBy,
            setAt: state.setAt,
            reason: state.reason,
            autoTrigger: state.autoTrigger,
            history,
        });
    });
    // ── POST /platform/operational-mode ───────────────────────────────────────
    router.post('/operational-mode', (req, res, next) => requirePlatformAdmin(req, res, next), async (req, res) => {
        const authed = req;
        const parsed = SetModeSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
            return;
        }
        const { mode, reason, autoTrigger } = parsed.data;
        await operationalMode.setMode(mode, {
            reason,
            setBy: authed.userId,
            autoTrigger,
        });
        const state = await operationalMode.getModeState();
        res.json({
            ok: true,
            currentMode: state?.currentMode ?? mode,
            modeName: OperationalModeService_js_1.MODE_NAMES[(state?.currentMode ?? mode)],
        });
    });
    // ── GET /platform/charter/thresholds ──────────────────────────────────────
    router.get('/charter/thresholds', async (_req, res) => {
        const [cfgResult, eventsResult] = await Promise.all([
            pool.query(`SELECT threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0,
                  updated_by, updated_at, notes
           FROM oweibo.identity_drift_thresholds
           WHERE id = TRUE`),
            pool.query(`SELECT id, detected_at, drift_axis, drift_magnitude,
                  acknowledged_at, acknowledged_by
           FROM oweibo.identity_drift_events
           ORDER BY detected_at DESC LIMIT 20`).catch(() => ({ rows: [] })),
        ]);
        const row = cfgResult.rows[0];
        const config = row
            ? {
                threshold_7d: parseFloat(row.threshold_7d),
                threshold_30d: parseFloat(row.threshold_30d),
                threshold_90d: parseFloat(row.threshold_90d),
                threshold_vs_v0: parseFloat(row.threshold_vs_v0),
                updated_by: row.updated_by,
                updated_at: row.updated_at,
                notes: row.notes,
            }
            : {
                threshold_7d: 0.15,
                threshold_30d: 0.20,
                threshold_90d: 0.25,
                threshold_vs_v0: 0.35,
                updated_by: 'default',
                updated_at: new Date().toISOString(),
                notes: null,
            };
        const recentEvents = eventsResult.rows.map(e => ({
            id: e.id,
            detected_at: e.detected_at,
            drift_axis: e.drift_axis,
            drift_magnitude: parseFloat(e.drift_magnitude),
            acknowledged_at: e.acknowledged_at,
            acknowledged_by: e.acknowledged_by,
        }));
        res.json({ config, recentEvents });
    });
    // ── POST /platform/charter/thresholds ─────────────────────────────────────
    router.post('/charter/thresholds', (req, res, next) => requirePlatformAdmin(req, res, next), async (req, res) => {
        const authed = req;
        const parsed = SetThresholdsSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
            return;
        }
        const { threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0, reason, changedBy } = parsed.data;
        const actor = changedBy ?? authed.userId;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Read current values for audit log
            const prev = await client.query(`SELECT threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0
           FROM oweibo.identity_drift_thresholds WHERE id = TRUE`);
            const p = prev.rows[0] ?? {
                threshold_7d: '0.15', threshold_30d: '0.20',
                threshold_90d: '0.25', threshold_vs_v0: '0.35',
            };
            // Update singleton
            await client.query(`UPDATE oweibo.identity_drift_thresholds
           SET threshold_7d = $1, threshold_30d = $2, threshold_90d = $3,
               threshold_vs_v0 = $4, updated_by = $5, updated_at = NOW(),
               notes = $6
           WHERE id = TRUE`, [threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0, actor, reason]);
            // Audit log
            await client.query(`INSERT INTO oweibo.identity_drift_threshold_changes
             (changed_by, prev_threshold_7d, prev_threshold_30d, prev_threshold_90d,
              prev_threshold_vs_v0, new_threshold_7d, new_threshold_30d, new_threshold_90d,
              new_threshold_vs_v0, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
                actor,
                parseFloat(p.threshold_7d), parseFloat(p.threshold_30d),
                parseFloat(p.threshold_90d), parseFloat(p.threshold_vs_v0),
                threshold_7d, threshold_30d, threshold_90d, threshold_vs_v0,
                reason,
            ]);
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
        res.json({ ok: true });
    });
    // ── GET /platform/promotions/pending (D.6) ────────────────────────────────
    router.get('/promotions/pending', async (_req, res) => {
        if (!promotionGate) {
            res.status(503).json({ error: 'promotion_gate_unavailable' });
            return;
        }
        const pending = await promotionGate.listPending();
        res.json({ pending });
    });
    // ── GET /platform/promotions/recent (D.6) ─────────────────────────────────
    router.get('/promotions/recent', async (req, res) => {
        if (!promotionGate) {
            res.status(503).json({ error: 'promotion_gate_unavailable' });
            return;
        }
        const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);
        const recent = await promotionGate.listRecentDecisions(limit);
        res.json({ recent });
    });
    // ── POST /platform/promotions/decide (D.6) ────────────────────────────────
    router.post('/promotions/decide', (req, res, next) => requirePlatformAdmin(req, res, next), async (req, res) => {
        if (!promotionGate) {
            res.status(503).json({ error: 'promotion_gate_unavailable' });
            return;
        }
        const authed = req;
        const parsed = PromotionDecisionSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
            return;
        }
        try {
            const result = await promotionGate.recordDecision({
                ...parsed.data,
                decidedBy: authed.userId,
            });
            if (!result.ok) {
                res.status(409).json({
                    error: 'gate_blocked',
                    message: 'Promotion still blocked for non-human reasons — review gate result and retry',
                    gateResult: result.gateResult,
                });
                return;
            }
            res.json({ ok: true, gateResult: result.gateResult });
        }
        catch (err) {
            res.status(409).json({
                error: 'decision_failed',
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });
    // ── GET /platform/prompts/mutations (D.12) ────────────────────────────────
    router.get('/prompts/mutations', async (req, res) => {
        if (!mutationGovernance) {
            res.status(503).json({ error: 'mutation_governance_unavailable' });
            return;
        }
        const role = typeof req.query['role'] === 'string' ? req.query['role'] : undefined;
        const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
        const filter = {};
        if (role)
            filter.role = role;
        if (status === 'mutable' || status === 'guarded' || status === 'frozen') {
            filter.status = status;
        }
        const slots = await mutationGovernance.listSlots(filter);
        res.json({ slots });
    });
    // ── GET /platform/prompts/mutations/:slot/:role (D.12) ────────────────────
    router.get('/prompts/mutations/:slot/:role', async (req, res) => {
        if (!mutationGovernance) {
            res.status(503).json({ error: 'mutation_governance_unavailable' });
            return;
        }
        const slotId = req.params['slot'];
        const role = req.params['role'];
        if (!slotId || !role) {
            res.status(400).json({ error: 'missing_params' });
            return;
        }
        const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);
        const history = await mutationGovernance.getHistory(slotId, role, limit);
        res.json({ history });
    });
    // ── POST /platform/prompts/mutations (D.12) ───────────────────────────────
    router.post('/prompts/mutations', (req, res, next) => requirePlatformAdmin(req, res, next), async (req, res) => {
        if (!mutationGovernance) {
            res.status(503).json({ error: 'mutation_governance_unavailable' });
            return;
        }
        const authed = req;
        const parsed = SetMutationStatusSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
            return;
        }
        const setStatusInput = {
            slotId: parsed.data.slotId,
            role: parsed.data.role,
            newStatus: parsed.data.newStatus,
            reason: parsed.data.reason,
            changedBy: authed.userId,
        };
        if (parsed.data.rfcUrl !== undefined) {
            setStatusInput.rfcUrl = parsed.data.rfcUrl;
        }
        const result = await mutationGovernance.setStatus(setStatusInput);
        if (!result.ok) {
            const status = result.error === 'rfc_required' ? 400
                : result.error === 'slot_not_found' ? 404
                    : 409;
            res.status(status).json(result);
            return;
        }
        res.json(result);
    });
    // ── GET /platform/cohorts/tenants (D.1) ───────────────────────────────────
    router.get('/cohorts/tenants', async (_req, res) => {
        if (!cohortAdmin) {
            res.status(503).json({ error: 'cohort_admin_unavailable' });
            return;
        }
        const tenants = await cohortAdmin.listTenants();
        res.json({ tenants });
    });
    // ── GET /platform/cohorts/channels (D.1) ──────────────────────────────────
    router.get('/cohorts/channels', async (_req, res) => {
        if (!cohortAdmin) {
            res.status(503).json({ error: 'cohort_admin_unavailable' });
            return;
        }
        const channels = await cohortAdmin.listChannels();
        res.json({ channels });
    });
    // ── GET /platform/cohorts/recent (D.1) ────────────────────────────────────
    router.get('/cohorts/recent', async (req, res) => {
        if (!cohortAdmin) {
            res.status(503).json({ error: 'cohort_admin_unavailable' });
            return;
        }
        const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);
        const recent = await cohortAdmin.listRecentChanges(limit);
        res.json({ recent });
    });
    // ── POST /platform/cohorts/tenants/:tenantId (D.1) ────────────────────────
    router.post('/cohorts/tenants/:tenantId', (req, res, next) => requirePlatformAdmin(req, res, next), async (req, res) => {
        if (!cohortAdmin) {
            res.status(503).json({ error: 'cohort_admin_unavailable' });
            return;
        }
        const authed = req;
        const tenantId = req.params['tenantId'];
        if (!tenantId) {
            res.status(400).json({ error: 'missing_tenant_id' });
            return;
        }
        const parsed = SetTenantCohortSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
            return;
        }
        const result = await cohortAdmin.setTenantCohort({
            tenantId,
            newChannel: parsed.data.newChannel,
            reason: parsed.data.reason,
            changedBy: authed.userId,
        });
        if (!result.ok) {
            const status = result.error === 'tenant_not_found' ? 404
                : result.error === 'unknown_channel' ? 400
                    : 409;
            res.status(status).json(result);
            return;
        }
        res.json(result);
    });
    return router;
}
//# sourceMappingURL=platform.routes.js.map