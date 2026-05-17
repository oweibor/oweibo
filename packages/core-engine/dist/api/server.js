"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
exports.startServer = startServer;
/**
 * server.ts — Express API server bootstrap (§5c.1, §18).
 *
 * Wires all routes, middleware, and DI. Starts the HTTP server
 * with OpenAPI docs at /api/v1/docs (swagger-ui-express).
 */
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const cors_1 = __importDefault(require("cors"));
const winston_1 = require("winston");
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const tasks_routes_js_1 = require("./routes/tasks.routes.js");
const hitl_routes_js_1 = require("./routes/hitl.routes.js");
const skills_routes_js_1 = require("./routes/skills.routes.js");
const platform_routes_js_1 = require("./routes/platform.routes.js");
const authenticate_js_1 = require("./middleware/authenticate.js");
const openapi_js_1 = require("./openapi.js");
const DEFAULT_CONFIG = {
    port: 3100,
    corsOrigins: ['http://localhost:3000'],
    rateLimitWindowMs: 15 * 60_000,
    rateLimitMax: 100,
};
const log = (0, winston_1.createLogger)({
    level: 'info',
    format: winston_1.format.combine(winston_1.format.timestamp(), winston_1.format.json()),
    transports: [new winston_1.transports.Console()],
});
/** Minimal in-memory rate limiter — no external dependency required. */
function createRateLimiter(windowMs, max) {
    const hits = new Map();
    return (req, res, next) => {
        const key = req.ip ?? 'unknown';
        const now = Date.now();
        const entry = hits.get(key);
        if (!entry || now > entry.resetAt) {
            hits.set(key, { count: 1, resetAt: now + windowMs });
            next();
            return;
        }
        if (entry.count >= max) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.status(429).json({ error: 'rate_limit_exceeded', retryAfter });
            return;
        }
        entry.count++;
        next();
    };
}
async function createServer(deps, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const app = (0, express_1.default)();
    // Security middleware
    app.use((0, helmet_1.default)());
    app.use((0, cors_1.default)({ origin: cfg.corsOrigins, credentials: true }));
    app.use(express_1.default.json({ limit: '1mb' }));
    // Health check (unauthenticated)
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    // OpenAPI docs (unauthenticated) — served at /api/v1/docs
    app.use('/api/v1/docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(openapi_js_1.openapiSpec, {
        customSiteTitle: 'oweibo API Docs',
    }));
    // Auth + rate limiting for all API routes
    const jwtCreds = await deps.secrets.getInfraCredentials('jwt');
    const jwtSecret = jwtCreds['JWT_SECRET'] ?? 'dev-secret-change-me';
    // Fail-closed if a real deployment ever boots with the placeholder secret.
    // Tokens signed with this value are forgeable by anyone reading the source.
    if (jwtSecret === 'dev-secret-change-me' && process.env['NODE_ENV'] === 'production') {
        throw new Error('JWT_SECRET is the development placeholder. ' +
            'Set a real secret in the secrets manager before starting in production.');
    }
    const auth = (0, authenticate_js_1.createAuthMiddleware)({ jwtSecret });
    const rateLimiter = createRateLimiter(cfg.rateLimitWindowMs, cfg.rateLimitMax);
    // API v1 routes
    const v1 = express_1.default.Router();
    v1.use(rateLimiter);
    v1.use(auth);
    v1.use('/tasks', (0, tasks_routes_js_1.createTasksRouter)({
        intentPipeline: deps.intentPipeline,
        taskEventBus: deps.taskEventBus,
        interventionGateway: deps.interventionGateway,
        taskStore: deps.taskStore,
    }));
    v1.use('/hitl', (0, hitl_routes_js_1.createHITLRouter)({ hitlGateway: deps.hitlGateway }));
    v1.use('/skills', (0, skills_routes_js_1.createSkillsRouter)());
    if (deps.pool && deps.operationalMode) {
        v1.use('/platform', (0, platform_routes_js_1.createPlatformRouter)({
            pool: deps.pool,
            operationalMode: deps.operationalMode,
            ...(deps.promotionGate ? { promotionGate: deps.promotionGate } : {}),
            ...(deps.mutationGovernance ? { mutationGovernance: deps.mutationGovernance } : {}),
        }));
    }
    app.use('/api/v1', v1);
    // Error handler
    app.use((err, _req, res, _next) => {
        log.error('Unhandled API error', { message: err.message, stack: err.stack });
        res.status(500).json({ error: 'internal_error', message: 'An internal error occurred' });
    });
    return { app, port: cfg.port };
}
async function startServer(...args) {
    const { app, port } = await createServer(...args);
    app.listen(port, () => {
        log.info('API server started', { port });
        log.info(`Health: http://localhost:${port}/health`);
        log.info(`API:    http://localhost:${port}/api/v1/`);
        log.info(`Docs:   http://localhost:${port}/api/v1/docs`);
    });
}
//# sourceMappingURL=server.js.map