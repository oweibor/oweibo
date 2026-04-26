/**
 * hitl.routes.ts — HITL (Human-In-The-Loop) approval routes (§5c.1).
 *
 * POST /hitl/:requestId/approve — approve a HITL escalation
 * POST /hitl/:requestId/reject  — reject a HITL escalation
 * GET  /hitl/pending             — list pending HITL requests
 *
 * tenantId is NEVER accepted from query params. It is always taken from
 * the authenticated JWT (req.tenantId injected by createAuthMiddleware).
 * This prevents a caller from listing or acting on another tenant's requests.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';

const HITLDecisionSchema = z.object({
  reason: z.string().optional(),
  modifications: z.record(z.string(), z.unknown()).optional(),
});

export interface HITLRouteDeps {
  readonly hitlGateway: {
    approve(requestId: string, decision: { reason?: string; modifications?: Record<string, unknown>; userId?: string; tenantId: string }): Promise<void>;
    reject(requestId: string, decision: { reason?: string; userId?: string; tenantId: string }): Promise<void>;
    listPending(tenantId: string): Promise<Array<{
      requestId: string;
      taskId: string;
      agentId: string;
      reason: string;
      escalatedAt: number;
    }>>;
  };
}

function authed(req: Request): AuthenticatedRequest {
  return req as unknown as AuthenticatedRequest;
}

export function createHITLRouter(deps: HITLRouteDeps): Router {
  const router = Router();

  // POST /hitl/:requestId/approve
  router.post('/:requestId/approve', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = HITLDecisionSchema.parse(req.body);
      const { userId, tenantId } = authed(req);

      await deps.hitlGateway.approve(req.params['requestId']!, {
        reason: body.reason,
        modifications: body.modifications,
        userId,
        tenantId,
      });

      res.json({ requestId: req.params['requestId']!, decision: 'approved' });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'validation_error', details: err.errors });
        return;
      }
      next(err);
    }
  });

  // POST /hitl/:requestId/reject
  router.post('/:requestId/reject', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = HITLDecisionSchema.parse(req.body);
      const { userId, tenantId } = authed(req);

      await deps.hitlGateway.reject(req.params['requestId']!, {
        reason: body.reason,
        userId,
        tenantId,
      });

      res.json({ requestId: req.params['requestId']!, decision: 'rejected' });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'validation_error', details: err.errors });
        return;
      }
      next(err);
    }
  });

  // GET /hitl/pending
  router.get('/pending', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId } = authed(req);
      const pending = await deps.hitlGateway.listPending(tenantId);
      res.json({ count: pending.length, requests: pending });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createHITLRouter;
