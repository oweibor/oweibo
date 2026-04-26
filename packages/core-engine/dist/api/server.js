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
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const tasks_routes_js_1 = require("./routes/tasks.routes.js");
const hitl_routes_js_1 = require("./routes/hitl.routes.js");
const skills_routes_js_1 = require("./routes/skills.routes.js");
const authenticate_js_1 = require("./middleware/authenticate.js");
const openapi_js_1 = require("./openapi.js");
const DEFAULT_CONFIG = {
    port: 3100,
    corsOrigins: ['http://localhost:3000'],
    rateLimitWindowMs: 15 * 60_000,
    rateLimitMax: 100,
};
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
    // The spec is imported from openapi.ts so it stays in sync with route definitions.
    app.use('/api/v1/docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(openapi_js_1.openapiSpec, {
        customSiteTitle: 'oweibo API Docs',
    }));
    // Auth middleware for API routes
    const jwtCreds = await deps.secrets.getInfraCredentials('jwt');
    const jwtSecret = jwtCreds['JWT_SECRET'] ?? 'dev-secret-change-me';
    const auth = (0, authenticate_js_1.createAuthMiddleware)({ jwtSecret });
    // API v1 routes
    const v1 = express_1.default.Router();
    v1.use(auth);
    v1.use('/tasks', (0, tasks_routes_js_1.createTasksRouter)({
        intentPipeline: deps.intentPipeline,
        taskEventBus: deps.taskEventBus,
        interventionGateway: deps.interventionGateway,
    }));
    v1.use('/hitl', (0, hitl_routes_js_1.createHITLRouter)({ hitlGateway: deps.hitlGateway }));
    v1.use('/skills', (0, skills_routes_js_1.createSkillsRouter)());
    app.use('/api/v1', v1);
    // Error handler
    app.use((err, _req, res, _next) => {
        console.error('[API] Unhandled error:', err.message);
        res.status(500).json({ error: 'internal_error', message: 'An internal error occurred' });
    });
    return { app, port: cfg.port };
}
async function startServer(...args) {
    const { app, port } = await createServer(...args);
    app.listen(port, () => {
        console.log(`[oweibo] API server listening on :${port}`);
        console.log(`[oweibo] Health: http://localhost:${port}/health`);
        console.log(`[oweibo] API:    http://localhost:${port}/api/v1/`);
        console.log(`[oweibo] Docs:   http://localhost:${port}/api/v1/docs`);
    });
}
//# sourceMappingURL=server.js.map