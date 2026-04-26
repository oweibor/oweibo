/**
 * server.ts — Express API server bootstrap (§5c.1, §18).
 *
 * Wires all routes, middleware, and DI. Starts the HTTP server
 * with OpenAPI docs at /api/v1/docs (swagger-ui-express).
 */
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createLogger, format, transports } from 'winston';
import swaggerUi from 'swagger-ui-express';
import { createTasksRouter } from './routes/tasks.routes.js';
import { createHITLRouter } from './routes/hitl.routes.js';
import { createSkillsRouter } from './routes/skills.routes.js';
import { createAuthMiddleware } from './middleware/authenticate.js';
import { openapiSpec } from './openapi.js';
import type { SecretsManager } from '../secrets/SecretsManager.js';

export interface ServerConfig {
  readonly port: number;
  readonly corsOrigins: string[];
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
}

const DEFAULT_CONFIG: ServerConfig = {
  port: 3100,
  corsOrigins: ['http://localhost:3000'],
  rateLimitWindowMs: 15 * 60_000,
  rateLimitMax: 100,
};

const log = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

/** Minimal in-memory rate limiter — no external dependency required. */
function createRateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
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

export async function createServer(
  deps: {
    secrets: SecretsManager;
    intentPipeline: Parameters<typeof createTasksRouter>[0]['intentPipeline'];
    taskEventBus: Parameters<typeof createTasksRouter>[0]['taskEventBus'];
    interventionGateway: Parameters<typeof createTasksRouter>[0]['interventionGateway'];
    hitlGateway: Parameters<typeof createHITLRouter>[0]['hitlGateway'];
    taskStore?: Parameters<typeof createTasksRouter>[0]['taskStore'];
  },
  config: Partial<ServerConfig> = {},
): Promise<{ app: import('express').Application; port: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors({ origin: cfg.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  // Health check (unauthenticated)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // OpenAPI docs (unauthenticated) — served at /api/v1/docs
  app.use(
    '/api/v1/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec as Parameters<typeof swaggerUi.setup>[0], {
      customSiteTitle: 'oweibo API Docs',
    }),
  );

  // Auth + rate limiting for all API routes
  const jwtCreds = await deps.secrets.getInfraCredentials('jwt');
  const jwtSecret = jwtCreds['JWT_SECRET'] ?? 'dev-secret-change-me';
  // Fail-closed if a real deployment ever boots with the placeholder secret.
  // Tokens signed with this value are forgeable by anyone reading the source.
  if (jwtSecret === 'dev-secret-change-me' && process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'JWT_SECRET is the development placeholder. ' +
      'Set a real secret in the secrets manager before starting in production.',
    );
  }
  const auth = createAuthMiddleware({ jwtSecret });
  const rateLimiter = createRateLimiter(cfg.rateLimitWindowMs, cfg.rateLimitMax);

  // API v1 routes
  const v1 = express.Router();
  v1.use(rateLimiter);
  v1.use(auth);
  v1.use('/tasks', createTasksRouter({
    intentPipeline: deps.intentPipeline,
    taskEventBus: deps.taskEventBus,
    interventionGateway: deps.interventionGateway,
    taskStore: deps.taskStore,
  }));
  v1.use('/hitl', createHITLRouter({ hitlGateway: deps.hitlGateway }));
  v1.use('/skills', createSkillsRouter());

  app.use('/api/v1', v1);

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error('Unhandled API error', { message: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal_error', message: 'An internal error occurred' });
  });

  return { app, port: cfg.port };
}

export async function startServer(
  ...args: Parameters<typeof createServer>
): Promise<void> {
  const { app, port } = await createServer(...args);
  app.listen(port, () => {
    log.info('API server started', { port });
    log.info(`Health: http://localhost:${port}/health`);
    log.info(`API:    http://localhost:${port}/api/v1/`);
    log.info(`Docs:   http://localhost:${port}/api/v1/docs`);
  });
}
