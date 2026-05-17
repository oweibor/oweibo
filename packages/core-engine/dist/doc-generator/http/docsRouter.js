"use strict";
/**
 * docsRouter — Express router for /api/v1/docs/* endpoints (§4.3.4, v10.5).
 *
 * Endpoints:
 *   POST   /generate               Enqueue a doc-gen job
 *   GET    /status/:sessionId      Session phase + progress + warnings (paginated)
 *   GET    /stream/:sessionId      SSE stream of TaskEventBus events
 *   POST   /cancel/:sessionId      Signal cancellation
 *   GET    /openapi.json           OpenAPI 3.1 spec (unauthenticated)
 *
 * All responses include Content-Type: application/vnd.oweibo.docs.v1+json
 * and the schema version field (C9, v10.5).
 *
 * Rate limits, SETNX guard, idempotency, and daily quota are enforced
 * by DocGeneratorQueue — the router validates request shape and delegates.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDocsRouter = createDocsRouter;
const node_path_1 = __importDefault(require("node:path"));
const express_1 = require("express");
const zod_1 = require("zod");
const DocExporter_js_1 = require("../rendering/DocExporter.js");
const openapi_js_1 = require("./openapi.js");
const API_CONTENT_TYPE = 'application/vnd.oweibo.docs.v1+json';
const SCHEMA_VERSION = 'v1';
// ── Zod schemas ───────────────────────────────────────────────────────────────
const GenerateBodySchema = zod_1.z.object({
    rootPath: zod_1.z.string().min(1),
    tenantId: zod_1.z.string().min(1),
    options: zod_1.z.object({
        skipLLM: zod_1.z.boolean().optional(),
        dryRun: zod_1.z.boolean().optional(),
        redactAuthors: zod_1.z.boolean().optional(),
        maxFiles: zod_1.z.number().int().positive().optional(),
        outputDir: zod_1.z.string().optional(),
        excludePatterns: zod_1.z.array(zod_1.z.string()).optional(),
        only: zod_1.z.array(zod_1.z.string()).optional(),
    }).optional(),
});
// ── Factory ───────────────────────────────────────────────────────────────────
function createDocsRouter(deps) {
    const exporter = new DocExporter_js_1.DocExporter();
    const router = (0, express_1.Router)();
    // ── Versioned content type ───────────────────────────────────────────────────
    router.use((_req, res, next) => {
        res.setHeader('Content-Type', API_CONTENT_TYPE);
        next();
    });
    // ── OpenAPI spec (unauthenticated) ───────────────────────────────────────────
    router.get('/openapi.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.json((0, openapi_js_1.docsOpenApiSpec)());
    });
    // ── POST /generate ───────────────────────────────────────────────────────────
    router.post('/generate', async (req, res) => {
        const parsed = GenerateBodySchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.issues, schemaVersion: SCHEMA_VERSION });
            return;
        }
        const { rootPath, tenantId, options } = parsed.data;
        const idempotencyKey = req.headers['idempotency-key'];
        // Pod-level concurrency gate (MED-9): reject before queueing if this pod is saturated.
        if (deps.getActiveJobCount && deps.maxConcurrentJobs !== undefined) {
            if (deps.getActiveJobCount() >= deps.maxConcurrentJobs) {
                res.status(429).json({
                    error: 'CONCURRENCY_LIMIT',
                    message: 'This pod has reached its concurrent job limit. Retry shortly.',
                    schemaVersion: SCHEMA_VERSION,
                });
                return;
            }
        }
        // Daily quota check
        const quota = await deps.queue.checkDailyQuota(tenantId);
        if (!quota.ok) {
            const secondsUntilMidnight = getSecondsUntilMidnightUTC();
            res.setHeader('Retry-After', String(secondsUntilMidnight));
            res.status(429).json({
                error: 'QUOTA_EXCEEDED',
                spent: quota.spent,
                limit: quota.limit,
                retryAfter: secondsUntilMidnight,
                schemaVersion: SCHEMA_VERSION,
            });
            return;
        }
        try {
            const analysisOptions = {
                tenantId,
                sessionId: '',
                ...options,
            };
            const result = await deps.queue.enqueue({
                tenantId,
                rootPath,
                outputDir: options?.outputDir,
                options: analysisOptions,
                idempotencyKey,
            });
            deps.audit.enqueued(tenantId, result.sessionId, rootPath, req.headers['x-user-id']);
            const statusCode = result.existing ? 200 : 202;
            res.status(statusCode).json({ sessionId: result.sessionId, queued: result.queued, schemaVersion: SCHEMA_VERSION });
        }
        catch (err) {
            res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message, schemaVersion: SCHEMA_VERSION });
        }
    });
    // ── GET /status/:sessionId ────────────────────────────────────────────────────
    router.get('/status/:sessionId', async (req, res) => {
        const sessionId = req.params['sessionId'] ?? '';
        const tenantId = (req.query['tenantId'] ?? '');
        if (!tenantId) {
            res.status(400).json({ error: 'MISSING_TENANT_ID', schemaVersion: SCHEMA_VERSION });
            return;
        }
        const page = Math.max(1, parseInt(req.query['page'] ?? '1', 10));
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query['pageSize'] ?? '50', 10)));
        const status = await deps.queue.getStatus(tenantId, sessionId);
        if (!status) {
            res.status(404).json({ error: 'SESSION_NOT_FOUND', sessionId, schemaVersion: SCHEMA_VERSION });
            return;
        }
        const allWarnings = status['warnings'] ?? [];
        const start = (page - 1) * pageSize;
        const warnings = allWarnings.slice(start, start + pageSize);
        res.json({
            sessionId,
            status: status['status'],
            phase: status['phase'],
            startedAt: status['startedAt'],
            completedAt: status['completedAt'],
            writtenFiles: status['writtenFiles'],
            warnings,
            warningCount: allWarnings.length,
            page,
            pageSize,
            totalPages: Math.ceil(allWarnings.length / pageSize),
            schemaVersion: SCHEMA_VERSION,
        });
    });
    // ── GET /stream/:sessionId (SSE) ──────────────────────────────────────────────
    router.get('/stream/:sessionId', async (req, res) => {
        // Accept negotiation (LOW-3): only serve SSE to clients that accept it.
        const accept = req.headers['accept'] ?? '';
        if (accept && !accept.includes('text/event-stream') && !accept.includes('*/*')) {
            res.status(406).json({ error: 'NOT_ACCEPTABLE', message: 'This endpoint only serves text/event-stream', schemaVersion: SCHEMA_VERSION });
            return;
        }
        const sessionId = req.params['sessionId'] ?? '';
        const tenantId = (req.query['tenantId'] ?? '');
        if (!tenantId) {
            res.status(400).end();
            return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const send = (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        // Pass tenantId so RedisTaskEventBus can route to the correct pub/sub channel (HIGH-9).
        const unsubResult = deps.eventBus.subscribe(tenantId, sessionId, send);
        const unsub = unsubResult instanceof Promise ? await unsubResult : unsubResult;
        req.on('close', () => { void unsub(); });
    });
    // ── GET /download/:sessionId ──────────────────────────────────────────────────
    router.get('/download/:sessionId', async (req, res) => {
        const sessionId = req.params['sessionId'] ?? '';
        const tenantId = (req.query['tenantId'] ?? '');
        if (!tenantId) {
            res.status(400).json({ error: 'MISSING_TENANT_ID', schemaVersion: SCHEMA_VERSION });
            return;
        }
        const status = await deps.queue.getStatus(tenantId, sessionId);
        if (!status) {
            res.status(404).json({ error: 'SESSION_NOT_FOUND', sessionId, schemaVersion: SCHEMA_VERSION });
            return;
        }
        if (status['status'] !== 'complete') {
            res.status(409).json({ error: 'SESSION_NOT_COMPLETE', sessionId, status: status['status'], schemaVersion: SCHEMA_VERSION });
            return;
        }
        const writtenFiles = status['writtenFiles'] ?? [];
        if (writtenFiles.length === 0) {
            res.status(404).json({ error: 'NO_FILES', sessionId, schemaVersion: SCHEMA_VERSION });
            return;
        }
        // Derive the output root from the first written file or the configured default.
        const outputRoot = deps.defaultOutputDir ?? node_path_1.default.dirname(writtenFiles[0]);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="docs-${sessionId.slice(0, 8)}.zip"`);
        res.setHeader('Cache-Control', 'no-store');
        try {
            await exporter.exportZip(writtenFiles, outputRoot, res);
        }
        catch (err) {
            if (!res.headersSent) {
                res.status(500).json({ error: 'EXPORT_FAILED', message: err.message, schemaVersion: SCHEMA_VERSION });
            }
        }
    });
    // ── POST /cancel/:sessionId ───────────────────────────────────────────────────
    router.post('/cancel/:sessionId', async (req, res) => {
        const sessionId = req.params['sessionId'] ?? '';
        const tenantId = (req.body['tenantId'] ?? '');
        if (!tenantId) {
            res.status(400).json({ error: 'MISSING_TENANT_ID', schemaVersion: SCHEMA_VERSION });
            return;
        }
        await deps.queue.cancel(tenantId, sessionId);
        deps.audit.cancelled(tenantId, sessionId, req.headers['x-user-id']);
        res.json({ sessionId, status: 'cancelled', schemaVersion: SCHEMA_VERSION });
    });
    return router;
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function getSecondsUntilMidnightUTC() {
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
}
//# sourceMappingURL=docsRouter.js.map