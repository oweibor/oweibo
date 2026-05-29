/**
 * tenantActions.routes.ts — F.4.3 HTTP surface for rollback invocation
 * and plan-level proposal reads. Mounted at the same
 * `/tenants/:tenantId/actions/*` base as actionsExtended; two routers
 * sharing the prefix is fine — Express stacks them.
 *
 *   POST /tenants/:tenantId/actions/:id/rollback             — invoke RollbackOrchestrator.execute
 *   GET  /tenants/:tenantId/actions/:id/rollback/status      — most-recent rollback row
 *   GET  /tenants/:tenantId/actions/plans/:planId            — plan detail + member count
 *   GET  /tenants/:tenantId/actions/plans/:planId/actions    — list member action_proposals
 *
 * Tenant scoping comes from the URL `:tenantId` param, cross-checked
 * against the JWT claim by `requireTenantParamMatchesJwt`. The plans/*
 * routes mount BEFORE the :id routes so the literal path segment wins.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { RollbackOrchestrator } from '../../action/RollbackOrchestrator.js';
import type { DryRunRegistry } from '../../action/DryRunRegistry.js';
import type { GatePrincipal } from '@oweibo/core-contracts';

function principalFromReq(req: AuthenticatedRequest): GatePrincipal {
  return {
    sub: req.userId,
    scopes: req.scopes,
    ctx: { tenantId: req.tenantId },
  };
}

const RollbackBody = z.object({
  reason: z.string().min(1).max(2000),
});

const PlanActionsQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export interface TenantActionsRouterDeps {
  readonly registry: DryRunRegistry;
  /** Optional — when undefined the rollback routes return 503. */
  readonly rollbackOrchestrator?: RollbackOrchestrator;
}

export function createTenantActionsRouter(deps: TenantActionsRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  // ── Plan reads (literal /plans/* — must come BEFORE the /:id routes) ──

  router.get('/plans/:planId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const planId = req.params['planId'] ?? '';
    try {
      const plan = await deps.registry.getPlan(principalFromReq(r), planId);
      if (!plan) {
        res.status(404).json({ error: 'not_found', message: `plan ${planId} not found` });
        return;
      }
      res.json({ plan });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/plans/:planId/actions', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const planId = req.params['planId'] ?? '';
    const parsed = PlanActionsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const proposals = await deps.registry.listPlanActions(
        principalFromReq(r),
        planId,
        parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {},
      );
      res.json({ planId, proposals, count: proposals.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Rollback (invoke + status) ────────────────────────────────────────

  router.post('/:id/rollback', async (req, res) => {
    if (!deps.rollbackOrchestrator) {
      res.status(503).json({
        error: 'rollback_disabled',
        message: 'RollbackOrchestrator is not configured',
      });
      return;
    }
    const r = req as unknown as AuthenticatedRequest;
    const parsed = RollbackBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const result = await deps.rollbackOrchestrator.execute({
        tenantId: r.tenantId,
        originalActionId: req.params['id'] ?? '',
        reason: parsed.data.reason,
        invokedBy: { type: 'human', id: r.userId },
      });
      const status = result.success ? 200 : 422;
      res.status(status).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/:id/rollback/status', async (req, res) => {
    if (!deps.rollbackOrchestrator) {
      res.status(503).json({
        error: 'rollback_disabled',
        message: 'RollbackOrchestrator is not configured',
      });
      return;
    }
    const r = req as unknown as AuthenticatedRequest;
    try {
      const status = await deps.rollbackOrchestrator.getStatus(r.tenantId, req.params['id'] ?? '');
      if (!status) {
        res.status(404).json({
          error: 'not_found',
          message: `no rollback execution recorded for ${req.params['id']}`,
        });
        return;
      }
      res.json(status);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : 'internal_error';
  if (/not found/i.test(message)) {
    res.status(404).json({ error: 'not_found', message });
    return;
  }
  if (/invalid|bad request|requires/i.test(message)) {
    res.status(400).json({ error: 'invalid_request', message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message });
}
