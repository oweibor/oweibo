/**
 * lineage.routes.ts — F.4.2 HTTP surface for the action-lineage read side.
 *
 *   GET /tenants/:tenantId/lineage/plans/:planId          — full plan tree
 *   GET /tenants/:tenantId/lineage/actions/:actionId      — single-action path
 *   GET /tenants/:tenantId/lineage/decisions/:decisionId  — gate decision history
 *
 * All endpoints are read-only and scoped to the tenant from the URL
 * param (cross-checked against the JWT via `requireTenantParamMatchesJwt`).
 * The recorder uses RLS internally (`SET LOCAL app.tenant_id`), so the
 * tenant scope is enforced at the database layer.
 */
import { Router, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { LineageRecorder } from '../../action/LineageRecorder.js';

export interface LineageRouterDeps {
  readonly lineage: LineageRecorder;
}

export function createLineageRouter(deps: LineageRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  // ── Plan lineage tree ─────────────────────────────────────────────────

  router.get('/plans/:planId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const planId = req.params['planId'] ?? '';
    try {
      const nodes = await deps.lineage.read(r.tenantId, planId);
      res.json({ planId, nodes, nodeCount: nodes.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Action lineage path ───────────────────────────────────────────────

  router.get('/actions/:actionId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const actionId = req.params['actionId'] ?? '';
    try {
      const nodes = await deps.lineage.readActionLineage(r.tenantId, actionId);
      res.json({ actionId, nodes, nodeCount: nodes.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Decision history (root + descendants) ─────────────────────────────

  router.get('/decisions/:decisionId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const decisionId = req.params['decisionId'] ?? '';
    try {
      const { decision, descendants } = await deps.lineage.readDecisionHistory(
        r.tenantId, decisionId,
      );
      if (!decision) {
        res.status(404).json({
          error: 'not_found',
          message: `lineage decision ${decisionId} not found`,
        });
        return;
      }
      res.json({ decision, descendants, descendantCount: descendants.length });
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
  res.status(500).json({ error: 'internal_error', message });
}
