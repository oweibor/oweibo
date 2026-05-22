"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createActionsRouter = createActionsRouter;
/**
 * actions.routes.ts — T.−1 action trust ladder HTTP surface.
 *
 * GET    /actions/pending             — list pending action proposals
 * GET    /actions/history             — list non-pending proposals
 * GET    /actions/:id                 — fetch a single proposal with full payload
 * POST   /actions/:id/promote         — promote (success | failure outcome)
 * POST   /actions/:id/reject          — reject with reason
 * POST   /actions/shadow/outcome      — record a shadow execution outcome
 * GET    /actions/trust-matrix        — list explicit trust-state rows
 * POST   /actions/trust-matrix/pin    — pin a class to a mode
 * POST   /actions/trust-matrix/unpin  — clear a pin
 *
 * All routes are tenant-scoped via the JWT's tenantId claim — RLS in the
 * DryRunRegistry / ActionTrustLadder transactions enforces isolation.
 */
const express_1 = require("express");
const zod_1 = require("zod");
function principalFromReq(req) {
    return {
        sub: req.userId,
        scopes: req.scopes,
        ctx: { tenantId: req.tenantId },
    };
}
const PromoteBody = zod_1.z.object({
    outcome: zod_1.z.enum(['success', 'failure']),
});
const RejectBody = zod_1.z.object({
    reason: zod_1.z.string().min(1).max(1000),
});
const ShadowOutcomeBody = zod_1.z.object({
    proposalId: zod_1.z.string().min(1).max(200),
    success: zod_1.z.boolean(),
    parity: zod_1.z.enum(['parity', 'drift', 'unknown']),
    diff: zod_1.z.unknown().optional(),
    reason: zod_1.z.string().optional(),
});
const PinBody = zod_1.z.object({
    actionClass: zod_1.z.string().min(1).max(200),
    mode: zod_1.z.enum(['execute', 'dry_run', 'shadow', 'require_approval', 'forbidden']),
    reason: zod_1.z.string().min(1).max(1000),
});
const UnpinBody = zod_1.z.object({
    actionClass: zod_1.z.string().min(1).max(200),
});
function createActionsRouter(deps) {
    const router = (0, express_1.Router)();
    router.get('/pending', async (req, res) => {
        const r = req;
        try {
            const items = await deps.registry.list(principalFromReq(r), { state: ['pending'] });
            res.json({ proposals: items, count: items.length });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.get('/history', async (req, res) => {
        const r = req;
        try {
            const items = await deps.registry.list(principalFromReq(r), {
                state: ['promoted', 'rejected', 'expired', 'executed_shadow', 'executed_live'],
                actionClass: typeof r.query.class === 'string' ? r.query.class : undefined,
            });
            res.json({ proposals: items, count: items.length });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.get('/trust-matrix', async (req, res) => {
        const r = req;
        try {
            const rows = await deps.registry.listTrustMatrix(principalFromReq(r));
            res.json({ rows, count: rows.length });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.post('/trust-matrix/pin', async (req, res) => {
        const r = req;
        const parsed = PinBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
            return;
        }
        try {
            await deps.registry.pin(principalFromReq(r), parsed.data.actionClass, parsed.data.mode, parsed.data.reason);
            res.json({ ok: true });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.post('/trust-matrix/unpin', async (req, res) => {
        const r = req;
        const parsed = UnpinBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
            return;
        }
        try {
            await deps.registry.unpin(principalFromReq(r), parsed.data.actionClass);
            res.json({ ok: true });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.get('/:id', async (req, res) => {
        const r = req;
        try {
            const proposal = await deps.registry.get(principalFromReq(r), req.params.id ?? '');
            if (!proposal) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            res.json(proposal);
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.post('/:id/promote', async (req, res) => {
        const r = req;
        const parsed = PromoteBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
            return;
        }
        try {
            await deps.trustLadder.promote(req.params.id ?? '', principalFromReq(r), parsed.data.outcome);
            res.json({ ok: true });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.post('/:id/reject', async (req, res) => {
        const r = req;
        const parsed = RejectBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
            return;
        }
        try {
            await deps.trustLadder.reject(req.params.id ?? '', principalFromReq(r), parsed.data.reason);
            res.json({ ok: true });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    router.post('/shadow/outcome', async (req, res) => {
        const r = req;
        const parsed = ShadowOutcomeBody.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
            return;
        }
        try {
            await deps.shadowExecutor.recordOutcome(principalFromReq(r), parsed.data);
            res.json({ ok: true });
        }
        catch (err) {
            handleError(err, res);
        }
    });
    return router;
}
function handleError(err, res) {
    const message = err instanceof Error ? err.message : 'internal_error';
    if (/already\s/.test(message)) {
        res.status(409).json({ error: 'conflict', message });
        return;
    }
    if (/no proposal/.test(message)) {
        res.status(404).json({ error: 'not_found', message });
        return;
    }
    res.status(500).json({ error: 'internal_error', message });
}
//# sourceMappingURL=actions.routes.js.map