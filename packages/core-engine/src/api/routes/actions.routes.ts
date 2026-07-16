/**
 * actions.routes.ts — T.−1 action trust ladder HTTP surface.
 *
 * GET    /actions/pending             — list pending action proposals
 * GET    /actions/history             — list non-pending proposals
 * GET    /actions/:id                 — fetch a single proposal with full payload
 * POST   /actions/:id/promote         — promote (success | failure outcome)
 * POST   /actions/:id/reject          — reject with reason
 * POST   /actions/shadow/outcome      — record a shadow execution outcome
 * GET    /actions/trust-matrix        — list explicit trust-state rows
 * POST   /actions/trust-matrix/pin    — pin a class to a mode
 * POST   /actions/trust-matrix/unpin  — clear a pin
 *
 * All routes are tenant-scoped via the JWT's tenantId claim — RLS in the
 * DryRunRegistry / ActionTrustLadder transactions enforces isolation.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireScopes } from '../middleware/authorize.js';
import type { ActionTrustLadder } from '../../action/ActionTrustLadder.js';
import type { DryRunRegistry } from '../../action/DryRunRegistry.js';
import type { ShadowExecutor } from '../../action/ShadowExecutor.js';
import type { GatePrincipal } from '@oweibo/core-contracts';

function principalFromReq(req: AuthenticatedRequest): GatePrincipal {
  return {
    sub: req.userId,
    scopes: req.scopes,
    ctx: { tenantId: req.tenantId },
  };
}

const PromoteBody = z.object({
  outcome: z.enum(['success', 'failure']),
});

const RejectBody = z.object({
  reason: z.string().min(1).max(1000),
});

const ShadowOutcomeBody = z.object({
  proposalId: z.string().min(1).max(200),
  success: z.boolean(),
  parity: z.enum(['parity', 'drift', 'unknown']),
  diff: z.unknown().optional(),
  reason: z.string().optional(),
});

const PinBody = z.object({
  actionClass: z.string().min(1).max(200),
  mode: z.enum(['execute', 'dry_run', 'shadow', 'require_approval', 'forbidden']),
  reason: z.string().min(1).max(1000),
});

const UnpinBody = z.object({
  actionClass: z.string().min(1).max(200),
});

export interface ActionsRouterDeps {
  trustLadder: ActionTrustLadder;
  registry: DryRunRegistry;
  shadowExecutor: ShadowExecutor;
}

export function createActionsRouter(deps: ActionsRouterDeps): Router {
  const router = Router();

  router.get('/pending', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const items = await deps.registry.list(principalFromReq(r), { state: ['pending'] });
      res.json({ proposals: items, count: items.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/history', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const items = await deps.registry.list(principalFromReq(r), {
        state: ['promoted', 'rejected', 'expired', 'executed_shadow', 'executed_live'],
        actionClass: typeof r.query.class === 'string' ? r.query.class : undefined,
      });
      res.json({ proposals: items, count: items.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/trust-matrix', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const rows = await deps.registry.listTrustMatrix(principalFromReq(r));
      res.json({ rows, count: rows.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // Pinning a trust mode is tenant-governance: it can loosen how autonomously
  // the agent acts. Require a tenant-admin-level scope (tenant:settings:write),
  // not the tasks:write that the rest of /actions uses.
  router.post('/trust-matrix/pin', requireScopes(['tenant:settings:write']), async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = PinBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.registry.pin(
        principalFromReq(r),
        parsed.data.actionClass,
        parsed.data.mode,
        parsed.data.reason,
      );
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/trust-matrix/unpin', requireScopes(['tenant:settings:write']), async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = UnpinBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.registry.unpin(principalFromReq(r), parsed.data.actionClass);
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/:id', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const proposal = await deps.registry.get(principalFromReq(r), req.params.id ?? '');
      if (!proposal) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(proposal);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/:id/promote', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = PromoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.trustLadder.promote(req.params.id ?? '', principalFromReq(r), parsed.data.outcome);
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/:id/reject', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = RejectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.trustLadder.reject(req.params.id ?? '', principalFromReq(r), parsed.data.reason);
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/shadow/outcome', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = ShadowOutcomeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.shadowExecutor.recordOutcome(principalFromReq(r), parsed.data);
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : 'internal_error';
  if (err instanceof Error && (err as { code?: string }).code === 'pin_below_action_class_floor') {
    res.status(403).json({ error: 'pin_below_action_class_floor', message });
    return;
  }
  if (/already\s/.test(message)) {
    res.status(409).json({ error: 'conflict', message });
    return;
  }
  if (/no proposal/.test(message)) {
    res.status(404).json({ error: 'not_found', message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message });
}
