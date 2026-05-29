/**
 * actionsExtended.routes.ts — skeleton HTTP surface for the S.4 / S.6
 * services that admin-web pages depend on.
 *
 * Endpoints (all tenant-scoped via the JWT's tenantId claim — same
 * pattern as actions.routes.ts):
 *
 *   GET    /actions/quotas/usage                  — current quota usage
 *   POST   /actions/quotas/preflight              — dry-run preflight check
 *   GET    /actions/grants                        — list active grants
 *   POST   /actions/grants                        — create a grant
 *   DELETE /actions/grants/:id                    — revoke a grant
 *   GET    /actions/approvals/:proposalId/quorum  — read-only quorum status
 *   POST   /actions/approvals/:proposalId/votes   — cast a vote
 *   POST   /actions/approvals/delegations         — create a delegation
 *
 * Each handler validates input with Zod and surfaces structured errors.
 * Service-layer exceptions translate to 4xx (validation) or 5xx
 * (internal) based on message-shape heuristics — same convention as
 * actions.routes.ts.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import type { MultiPartyApprovalService } from '../../action/MultiPartyApprovalService.js';
import type { QuotaService } from '../../action/QuotaService.js';
import type {
  ActionClass,
  GrantScopeFilter,
} from '@oweibo/core-contracts';

// ── Schemas ──────────────────────────────────────────────────────────────

const ScopeFilterSchema = z.object({
  fieldPath: z.string().min(1).max(200),
  operator: z.enum(['eq', 'in', 'matches']),
  value: z.unknown(),
}).optional();

const CreateGrantBody = z.object({
  actionClass: z.string().min(1).max(200),
  grantedByUserIds: z.array(z.string().uuid()).min(1).max(10),
  grantedToKind: z.enum(['agent', 'user']),
  grantedToUserId: z.string().uuid().optional(),
  scopeFilter: ScopeFilterSchema,
  durationSeconds: z.number().int().positive().max(7 * 24 * 60 * 60),
  maxUses: z.number().int().positive().max(10_000),
});

const CastVoteBody = z.object({
  vote: z.enum(['approve', 'reject']),
  comment: z.string().max(2000).optional(),
  onBehalfOf: z.string().uuid().optional(),
});

const CreateDelegationBody = z.object({
  delegateUserId: z.string().uuid(),
  actionClass: z.union([z.literal('*'), z.string().min(1).max(200)]),
  durationSeconds: z.number().int().positive().max(7 * 24 * 60 * 60),
});

const PreflightBody = z.object({
  actionClass: z.string().min(1).max(200),
  estimatedCostUsdCents: z.number().int().nonnegative().optional(),
  blastRadiusUsers: z.number().int().nonnegative().optional(),
});

const QuotaUsageQuery = z.object({
  actionClass: z.string().min(1).max(200).optional(),
});

// ── Router ───────────────────────────────────────────────────────────────

export interface ActionsExtendedRouterDeps {
  multiPartyApproval: MultiPartyApprovalService;
  quotaService: QuotaService;
}

export function createActionsExtendedRouter(deps: ActionsExtendedRouterDeps): Router {
  const router = Router();

  // ── Quotas ────────────────────────────────────────────────────────────

  router.get('/quotas/usage', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = QuotaUsageQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const usage = await deps.quotaService.usage(r.tenantId, parsed.data.actionClass);
      res.json({ usage });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/quotas/preflight', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = PreflightBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const result = await deps.quotaService.preflight({
        tenantId: r.tenantId,
        actionClass: parsed.data.actionClass as ActionClass,
        ...(parsed.data.estimatedCostUsdCents !== undefined
          ? { estimatedCostUsdCents: parsed.data.estimatedCostUsdCents }
          : {}),
        ...(parsed.data.blastRadiusUsers !== undefined
          ? { blastRadiusUsers: parsed.data.blastRadiusUsers }
          : {}),
      });
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Grants ────────────────────────────────────────────────────────────

  router.get('/grants', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const grants = await deps.multiPartyApproval.listGrants(r.tenantId);
      res.json({ grants });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/grants', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = CreateGrantBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const grant = await deps.multiPartyApproval.createGrant({
        tenantId: r.tenantId,
        actionClass: parsed.data.actionClass as ActionClass,
        grantedByUserIds: parsed.data.grantedByUserIds,
        grantedToKind: parsed.data.grantedToKind,
        ...(parsed.data.grantedToUserId ? { grantedToUserId: parsed.data.grantedToUserId } : {}),
        ...(parsed.data.scopeFilter ? { scopeFilter: parsed.data.scopeFilter as GrantScopeFilter } : {}),
        durationSeconds: parsed.data.durationSeconds,
        maxUses: parsed.data.maxUses,
      });
      res.status(201).json(grant);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.delete('/grants/:id', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      await deps.multiPartyApproval.revokeGrant(r.tenantId, req.params.id ?? '', r.userId);
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Approvals (votes + quorum) ────────────────────────────────────────

  router.get('/approvals/:proposalId/quorum', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const status = await deps.multiPartyApproval.getQuorumStatus(
        r.tenantId,
        req.params.proposalId ?? '',
      );
      res.json(status);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/approvals/:proposalId/votes', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = CastVoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const status = await deps.multiPartyApproval.castVote({
        tenantId: r.tenantId,
        proposalId: req.params.proposalId ?? '',
        voterUserId: r.userId,
        vote: parsed.data.vote,
        ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
        ...(parsed.data.onBehalfOf ? { onBehalfOf: parsed.data.onBehalfOf } : {}),
      });
      res.json(status);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/approvals/delegations', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = CreateDelegationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.multiPartyApproval.createDelegation({
        tenantId: r.tenantId,
        delegatorUserId: r.userId,
        delegateUserId: parsed.data.delegateUserId,
        actionClass: parsed.data.actionClass as ActionClass | '*',
        durationSeconds: parsed.data.durationSeconds,
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : 'internal_error';
  // Validation-shaped errors → 400.
  if (/^(?:grant requires|grant duration|grant maxUses|grants disabled|grantedToKind|cannot delegate|delegation disabled|delegate .* is already|delegator .* is already|voter .* is not in the approver set|castVote: proposal .* is)/.test(message)) {
    res.status(400).json({ error: 'invalid_request', message });
    return;
  }
  if (/not found/i.test(message)) {
    res.status(404).json({ error: 'not_found', message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message });
}
