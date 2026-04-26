"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHITLRouter = createHITLRouter;
/**
 * hitl.routes.ts — HITL (Human-In-The-Loop) approval routes (§5c.1).
 *
 * POST /hitl/:requestId/approve — approve a HITL escalation
 * POST /hitl/:requestId/reject  — reject a HITL escalation
 * GET  /hitl/pending             — list pending HITL requests
 */
const express_1 = require("express");
const zod_1 = require("zod");
const HITLDecisionSchema = zod_1.z.object({
    reason: zod_1.z.string().optional(),
    modifications: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
});
function createHITLRouter(deps) {
    const router = (0, express_1.Router)();
    // POST /hitl/:requestId/approve
    router.post('/:requestId/approve', async (req, res, next) => {
        try {
            const body = HITLDecisionSchema.parse(req.body);
            const userId = req.userId;
            await deps.hitlGateway.approve(req.params['requestId'], {
                reason: body.reason,
                modifications: body.modifications,
                userId,
            });
            res.json({ requestId: req.params['requestId'], decision: 'approved' });
        }
        catch (err) {
            if (err instanceof zod_1.z.ZodError) {
                res.status(400).json({ error: 'validation_error', details: err.errors });
                return;
            }
            next(err);
        }
    });
    // POST /hitl/:requestId/reject
    router.post('/:requestId/reject', async (req, res, next) => {
        try {
            const body = HITLDecisionSchema.parse(req.body);
            const userId = req.userId;
            await deps.hitlGateway.reject(req.params['requestId'], {
                reason: body.reason,
                userId,
            });
            res.json({ requestId: req.params['requestId'], decision: 'rejected' });
        }
        catch (err) {
            if (err instanceof zod_1.z.ZodError) {
                res.status(400).json({ error: 'validation_error', details: err.errors });
                return;
            }
            next(err);
        }
    });
    // GET /hitl/pending
    router.get('/pending', async (req, res, next) => {
        try {
            const tenantId = req.query.tenantId;
            const pending = await deps.hitlGateway.listPending(tenantId);
            res.json({ count: pending.length, requests: pending });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
exports.default = createHITLRouter;
//# sourceMappingURL=hitl.routes.js.map