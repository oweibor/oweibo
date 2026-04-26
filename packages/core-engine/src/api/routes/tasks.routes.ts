/**
 * tasks.routes.ts — REST API task routes (§5c.1).
 *
 * POST /tasks              — submit a new task
 * POST /tasks/:id/clarify  — respond to clarification questions
 * GET  /tasks/:id/events   — SSE stream of task events
 * POST /tasks/:id/redirect — mid-task intervention (redirect/pause/cancel/add-constraint)
 * GET  /tasks/:id          — get task status (stage, progress, timestamps, error)
 *
 * tenantId is NEVER accepted from the request body. It is always taken from
 * the authenticated JWT (req.tenantId injected by createAuthMiddleware).
 * This prevents a caller from escalating to another tenant's data.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';

// ---------------------------------------------------------------------------
// Request schemas — tenantId intentionally absent (comes from JWT only)
// ---------------------------------------------------------------------------

const SubmitTaskSchema = z.object({
  instruction:  z.string().min(1).max(10_000),
  sessionId:    z.string().uuid().optional(),
  deliveryMode: z.enum(['download-link', 'git-push', 'webhook', 'channel-reply']).optional(),
  gitRepoUrl:   z.string().url().optional(),
  gitBranch:    z.string().optional(),
  webhookUrl:   z.string().url().optional(),
  repoPath:     z.string().optional(),
  // Note: tenantId is NOT accepted here — taken from JWT to prevent spoofing
});

const ClarifySchema = z.object({
  answers: z.record(z.string(), z.string()),
});

const InterventionSchema = z.object({
  type:    z.enum(['redirect', 'pause', 'cancel', 'add-constraint']),
  payload: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TaskRouteDeps {
  readonly intentPipeline: {
    submit(raw: {
      instruction: string;
      channel:     string;
      userId?:     string;
      sessionId?:  string;
      tenantId:    string;     // now required — always provided from JWT
      repoPath?:   string;
      deliveryConfig?: unknown;
    }): Promise<{
      taskId: string;
      status: string;
      clarifyingQuestions?: Array<{ id: string; question: string }>;
    }>;
    clarify(taskId: string, answers: Record<string, string>, tenantId: string): Promise<{
      taskId: string;
      status: string;
    }>;
  };
  readonly taskEventBus: {
    subscribe(taskId: string, handler: (event: unknown) => void): () => void;
  };
  readonly interventionGateway: {
    submit(intervention: {
      taskId:   string;
      type:     string;
      payload?: string;
      source:   string;
      userId?:  string;
      tenantId: string;        // required for ownership validation
    }): Promise<void>;
  };
  /** Optional: fetch task metadata for ownership checks and status. */
  readonly taskStore?: {
    getTenantId(taskId: string): Promise<string | null>;
    getStatus(taskId: string): Promise<{
      status: string;
      stage?: string;
      progress?: number;
      startedAt?: string;
      completedAt?: string;
      error?: string;
    } | null>;
  };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function authed(req: Request): AuthenticatedRequest {
  return req as unknown as AuthenticatedRequest;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createTasksRouter(deps: TaskRouteDeps): Router {
  const router = Router();

  // POST /tasks — submit a new task
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body     = SubmitTaskSchema.parse(req.body);
      const { userId, tenantId } = authed(req);   // tenantId from JWT

      const result = await deps.intentPipeline.submit({
        instruction: body.instruction,
        channel:     'api',
        userId,
        tenantId,                                  // from JWT — never from body
        sessionId:   body.sessionId ?? randomUUID(),
        repoPath:    body.repoPath,
        deliveryConfig: body.deliveryMode ? {
          mode:       body.deliveryMode,
          gitRepoUrl: body.gitRepoUrl,
          gitBranch:  body.gitBranch,
          webhookUrl: body.webhookUrl,
        } : undefined,
      });

      if (result.clarifyingQuestions && result.clarifyingQuestions.length > 0) {
        res.status(202).json({
          taskId:   result.taskId,
          status:   'needs_clarification',
          questions: result.clarifyingQuestions,
        });
        return;
      }

      res.status(201).json({ taskId: result.taskId, status: result.status });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'validation_error', details: err.errors });
        return;
      }
      next(err);
    }
  });

  // POST /tasks/:id/clarify — respond to clarification questions
  router.post('/:id/clarify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body     = ClarifySchema.parse(req.body);
      const { tenantId } = authed(req);

      // Ownership check: verify the task belongs to the caller's tenant
      if (deps.taskStore) {
        const ownerTenantId = await deps.taskStore.getTenantId(req.params['id']!);
        if (ownerTenantId !== null && ownerTenantId !== tenantId) {
          // Return 404 to avoid enumeration — same pattern as kilo-pipeline
          res.status(404).json({ error: 'not_found', message: `Task ${req.params['id']!} not found` });
          return;
        }
      }

      const result = await deps.intentPipeline.clarify(req.params['id']!, body.answers, tenantId);
      res.json({ taskId: result.taskId, status: result.status });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'validation_error', details: err.errors });
        return;
      }
      next(err);
    }
  });

  // GET /tasks/:id/events — SSE stream of task events
  router.get('/:id/events', async (req: Request, res: Response) => {
    const { tenantId } = authed(req);

    // Ownership check before opening stream
    if (deps.taskStore) {
      const ownerTenantId = await deps.taskStore.getTenantId(req.params['id']!);
      if (ownerTenantId !== null && ownerTenantId !== tenantId) {
        res.status(404).json({ error: 'not_found', message: `Task ${req.params['id']!} not found` });
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', taskId: req.params['id']! })}\n\n`);

    const unsubscribe = deps.taskEventBus.subscribe(req.params['id']!, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // POST /tasks/:id/redirect — mid-task intervention
  router.post('/:id/redirect', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = InterventionSchema.parse(req.body);
      const { userId, tenantId } = authed(req);

      // Ownership check
      if (deps.taskStore) {
        const ownerTenantId = await deps.taskStore.getTenantId(req.params['id']!);
        if (ownerTenantId !== null && ownerTenantId !== tenantId) {
          res.status(404).json({ error: 'not_found', message: `Task ${req.params['id']!} not found` });
          return;
        }
      }

      await deps.interventionGateway.submit({
        taskId:  req.params['id']!,
        type:    body.type,
        payload: body.payload,
        source:  'api',
        userId,
        tenantId,
      });

      res.json({ taskId: req.params['id']!, intervention: body.type, status: 'applied' });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'validation_error', details: err.errors });
        return;
      }
      next(err);
    }
  });

  // GET /tasks/:id — get task status
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = authed(req);
      const taskId = req.params['id']!;

      if (!deps.taskStore) {
        res.status(503).json({ error: 'service_unavailable', message: 'Task store not configured' });
        return;
      }

      const ownerTenantId = await deps.taskStore.getTenantId(taskId);
      if (ownerTenantId === null || ownerTenantId !== tenantId) {
        res.status(404).json({ error: 'not_found', message: `Task ${taskId} not found` });
        return;
      }

      const taskStatus = await deps.taskStore.getStatus(taskId);
      if (!taskStatus) {
        res.status(404).json({ error: 'not_found', message: `Task ${taskId} not found` });
        return;
      }

      res.json({ taskId, ...taskStatus });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createTasksRouter;
