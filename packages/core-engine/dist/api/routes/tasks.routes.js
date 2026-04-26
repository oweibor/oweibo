"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTasksRouter = createTasksRouter;
/**
 * tasks.routes.ts — REST API task routes (§5c.1).
 *
 * POST /tasks              — submit a new task
 * POST /tasks/:id/clarify  — respond to clarification questions
 * GET  /tasks/:id/events   — SSE stream of task events
 * POST /tasks/:id/redirect — mid-task intervention (redirect/pause/cancel)
 * GET  /tasks/:id          — get task status
 *
 * tenantId is NEVER accepted from the request body. It is always taken from
 * the authenticated JWT (req.tenantId injected by createAuthMiddleware).
 * This prevents a caller from escalating to another tenant's data.
 */
const express_1 = require("express");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
// ---------------------------------------------------------------------------
// Request schemas — tenantId intentionally absent (comes from JWT only)
// ---------------------------------------------------------------------------
const SubmitTaskSchema = zod_1.z.object({
    instruction: zod_1.z.string().min(1).max(10_000),
    sessionId: zod_1.z.string().uuid().optional(),
    deliveryMode: zod_1.z.enum(['download-link', 'git-push', 'webhook', 'channel-reply']).optional(),
    gitRepoUrl: zod_1.z.string().url().optional(),
    gitBranch: zod_1.z.string().optional(),
    webhookUrl: zod_1.z.string().url().optional(),
    repoPath: zod_1.z.string().optional(),
    // Note: tenantId is NOT accepted here — taken from JWT to prevent spoofing
});
const ClarifySchema = zod_1.z.object({
    answers: zod_1.z.record(zod_1.z.string(), zod_1.z.string()),
});
const InterventionSchema = zod_1.z.object({
    type: zod_1.z.enum(['redirect', 'pause', 'cancel', 'add-constraint']),
    payload: zod_1.z.string().optional(),
});
// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function authed(req) {
    return req;
}
// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
function createTasksRouter(deps) {
    const router = (0, express_1.Router)();
    // POST /tasks — submit a new task
    router.post('/', async (req, res, next) => {
        try {
            const body = SubmitTaskSchema.parse(req.body);
            const { userId, tenantId } = authed(req); // tenantId from JWT
            const result = await deps.intentPipeline.submit({
                instruction: body.instruction,
                channel: 'api',
                userId,
                tenantId, // from JWT — never from body
                sessionId: body.sessionId ?? (0, crypto_1.randomUUID)(),
                repoPath: body.repoPath,
                deliveryConfig: body.deliveryMode ? {
                    mode: body.deliveryMode,
                    gitRepoUrl: body.gitRepoUrl,
                    gitBranch: body.gitBranch,
                    webhookUrl: body.webhookUrl,
                } : undefined,
            });
            if (result.clarifyingQuestions && result.clarifyingQuestions.length > 0) {
                res.status(202).json({
                    taskId: result.taskId,
                    status: 'needs_clarification',
                    questions: result.clarifyingQuestions,
                });
                return;
            }
            res.status(201).json({ taskId: result.taskId, status: result.status });
        }
        catch (err) {
            if (err instanceof zod_1.z.ZodError) {
                res.status(400).json({ error: 'validation_error', details: err.errors });
                return;
            }
            next(err);
        }
    });
    // POST /tasks/:id/clarify — respond to clarification questions
    router.post('/:id/clarify', async (req, res, next) => {
        try {
            const body = ClarifySchema.parse(req.body);
            const { tenantId } = authed(req);
            // Ownership check: verify the task belongs to the caller's tenant
            if (deps.taskStore) {
                const ownerTenantId = await deps.taskStore.getTenantId(req.params['id']);
                if (ownerTenantId !== null && ownerTenantId !== tenantId) {
                    // Return 404 to avoid enumeration — same pattern as kilo-pipeline
                    res.status(404).json({ error: 'not_found', message: `Task ${req.params['id']} not found` });
                    return;
                }
            }
            const result = await deps.intentPipeline.clarify(req.params['id'], body.answers, tenantId);
            res.json({ taskId: result.taskId, status: result.status });
        }
        catch (err) {
            if (err instanceof zod_1.z.ZodError) {
                res.status(400).json({ error: 'validation_error', details: err.errors });
                return;
            }
            next(err);
        }
    });
    // GET /tasks/:id/events — SSE stream of task events
    router.get('/:id/events', async (req, res) => {
        const { tenantId } = authed(req);
        // Ownership check before opening stream
        if (deps.taskStore) {
            const ownerTenantId = await deps.taskStore.getTenantId(req.params['id']);
            if (ownerTenantId !== null && ownerTenantId !== tenantId) {
                res.status(404).json({ error: 'not_found', message: `Task ${req.params['id']} not found` });
                return;
            }
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', taskId: req.params['id'] })}\n\n`);
        const unsubscribe = deps.taskEventBus.subscribe(req.params['id'], (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 15_000);
        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    });
    // POST /tasks/:id/redirect — mid-task intervention
    router.post('/:id/redirect', async (req, res, next) => {
        try {
            const body = InterventionSchema.parse(req.body);
            const { userId, tenantId } = authed(req);
            // Ownership check
            if (deps.taskStore) {
                const ownerTenantId = await deps.taskStore.getTenantId(req.params['id']);
                if (ownerTenantId !== null && ownerTenantId !== tenantId) {
                    res.status(404).json({ error: 'not_found', message: `Task ${req.params['id']} not found` });
                    return;
                }
            }
            await deps.interventionGateway.submit({
                taskId: req.params['id'],
                type: body.type,
                payload: body.payload,
                source: 'api',
                userId,
                tenantId,
            });
            res.json({ taskId: req.params['id'], intervention: body.type, status: 'applied' });
        }
        catch (err) {
            if (err instanceof zod_1.z.ZodError) {
                res.status(400).json({ error: 'validation_error', details: err.errors });
                return;
            }
            next(err);
        }
    });
    // GET /tasks/:id — get task status
    router.get('/:id', async (req, res) => {
        const { tenantId } = authed(req);
        // Ownership check
        if (deps.taskStore) {
            const ownerTenantId = await deps.taskStore.getTenantId(req.params['id']);
            if (ownerTenantId !== null && ownerTenantId !== tenantId) {
                res.status(404).json({ error: 'not_found', message: `Task ${req.params['id']} not found` });
                return;
            }
        }
        res.json({ taskId: req.params['id'], status: 'unknown' });
    });
    return router;
}
exports.default = createTasksRouter;
//# sourceMappingURL=tasks.routes.js.map