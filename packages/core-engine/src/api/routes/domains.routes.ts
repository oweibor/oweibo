/**
 * domains.routes.ts — F.4.5 HTTP surface for the domain-depth admin
 * pages (F.4.8). All endpoints scope to the URL `:tenantId` param,
 * cross-checked against the JWT claim by `requireTenantParamMatchesJwt`.
 *
 *   GET    /tenants/:tenantId/domains/registry                — canonical taxonomy
 *   GET    /tenants/:tenantId/domains/bindings                — current bindings
 *   PUT    /tenants/:tenantId/domains/bindings                — replace bindings
 *   GET    /tenants/:tenantId/domains/sme-review              — pending tenant reviews
 *   POST   /tenants/:tenantId/domains/sme-review/:id/vote     — submit a review vote
 *   GET    /tenants/:tenantId/domains/depth                   — latest depth snapshot per domain
 *   GET    /tenants/:tenantId/domains/compliance/evaluations  — recent noteworthy verdicts
 *   POST   /tenants/:tenantId/domains/compliance/refresh      — invalidate binding cache
 *
 * Bindings replacement validates structure inside the service. Sme-review
 * vote routes the request to SmeReviewService.submitReview — the service
 * enforces idempotency via UNIQUE(queue_item_id, reviewer_id).
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { DomainRegistry } from '../../domain/DomainRegistry.js';
import type { TenantDomainBindingService } from '../../domain/TenantDomainBindingService.js';
import type { SmeReviewService } from '../../domain/SmeReviewService.js';
import type { DomainDepthMetrics } from '../../domain/DomainDepthMetrics.js';
import type { PgComplianceEvaluationReader } from '../../domain/PgComplianceEvaluationReader.js';
import type { PgTenantDomainBindingLookup } from '../../domain/PgTenantDomainBindingLookup.js';
import type {
  SmeOverallVerdict,
  TenantDomainBindingInput,
  TenantDomainBindingRole,
} from '@oweibo/core-contracts';

// ── Schemas ──────────────────────────────────────────────────────────────

const BindingInputSchema = z.object({
  domainSlug: z.string().min(1).max(80),
  role: z.enum(['primary', 'secondary']),
  rawWeight: z.number().min(0).max(1),
  boundBy: z.object({
    type: z.enum(['classifier', 'admin', 'sme']),
    id: z.string().min(1).max(200),
  }),
  confidence: z.number().min(0).max(1).nullish(),
});

const PutBindingsBody = z.object({
  bindings: z.array(BindingInputSchema).max(20),
  force: z.boolean().optional(),
});

const SmeVoteBody = z.object({
  overallVerdict: z.enum(['accept', 'reject', 'request_changes', 'abstain']),
  perCriterion: z.array(z.object({
    criterionId: z.string().min(1).max(80),
    verdict: z.enum(['pass', 'fail', 'partial']),
    note: z.string().max(2000).optional(),
  })).optional(),
  ontologySuggestions: z.array(z.unknown()).optional(),
  rubricSuggestions: z.array(z.unknown()).optional(),
  ruleSuggestions: z.array(z.unknown()).optional(),
  comment: z.string().max(4000).optional(),
});

const SmeListQuery = z.object({
  state: z.union([z.string(), z.array(z.string())]).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const EvalListQuery = z.object({
  verdict: z.union([z.string(), z.array(z.string())]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

// ── Router ───────────────────────────────────────────────────────────────

export interface DomainsRouterDeps {
  readonly registry: DomainRegistry;
  readonly bindingService: TenantDomainBindingService;
  readonly bindingLookup: PgTenantDomainBindingLookup;
  readonly smeReview: SmeReviewService;
  readonly depthMetrics: DomainDepthMetrics;
  readonly evaluations: PgComplianceEvaluationReader;
}

export function createDomainsRouter(deps: DomainsRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  // ── Registry ──────────────────────────────────────────────────────────

  router.get('/registry', async (_req, res) => {
    try {
      const entries = deps.registry.list();
      res.json({ entries, count: entries.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Bindings (GET / PUT) ──────────────────────────────────────────────

  router.get('/bindings', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const bindings = await deps.bindingService.listBindings(r.tenantId);
      res.json({ bindings, count: bindings.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.put('/bindings', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = PutBindingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const bindings = await deps.bindingService.replaceBindings({
        tenantId: r.tenantId,
        bindings: parsed.data.bindings.map((b): TenantDomainBindingInput => ({
          domainSlug: b.domainSlug,
          role: b.role as TenantDomainBindingRole,
          rawWeight: b.rawWeight,
          boundBy: b.boundBy,
          ...(b.confidence !== null && b.confidence !== undefined
            ? { confidence: b.confidence }
            : {}),
        })),
        ...(parsed.data.force !== undefined ? { force: parsed.data.force } : {}),
      });
      // Successful write invalidates the per-tenant lookup cache so a
      // subsequent gate call hits the new set instead of waiting 60s.
      deps.bindingLookup.invalidate(r.tenantId);
      res.json({ bindings, count: bindings.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── SME review (list + vote) ──────────────────────────────────────────

  router.get('/sme-review', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = SmeListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const states = parsed.data.state === undefined
        ? undefined
        : Array.isArray(parsed.data.state) ? parsed.data.state : [parsed.data.state];
      const items = await deps.smeReview.listPendingForTenant(r.tenantId, {
        ...(states ? { states: states as never } : {}),
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      });
      res.json({ items, count: items.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/sme-review/:id/vote', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = SmeVoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const reviewId = await deps.smeReview.submitReview({
        queueItemId: req.params['id'] ?? '',
        reviewerId: r.userId,
        overallVerdict: parsed.data.overallVerdict as SmeOverallVerdict,
        ...(parsed.data.perCriterion !== undefined
          ? { perCriterion: parsed.data.perCriterion as never }
          : {}),
        ...(parsed.data.ontologySuggestions !== undefined
          ? { ontologySuggestions: parsed.data.ontologySuggestions as never }
          : {}),
        ...(parsed.data.rubricSuggestions !== undefined
          ? { rubricSuggestions: parsed.data.rubricSuggestions as never }
          : {}),
        ...(parsed.data.ruleSuggestions !== undefined
          ? { ruleSuggestions: parsed.data.ruleSuggestions as never }
          : {}),
        ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
      });
      res.status(201).json({ reviewId });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Depth metrics ─────────────────────────────────────────────────────

  router.get('/depth', async (_req, res) => {
    try {
      const snapshots = await deps.depthMetrics.listLatestSnapshots();
      res.json({ snapshots, count: snapshots.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Compliance evaluations + refresh ──────────────────────────────────

  router.get('/compliance/evaluations', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = EvalListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const verdicts = parsed.data.verdict === undefined
        ? undefined
        : Array.isArray(parsed.data.verdict) ? parsed.data.verdict : [parsed.data.verdict];
      const { rows, nextCursor } = await deps.evaluations.listForTenant(r.tenantId, {
        ...(verdicts ? { verdicts: verdicts as never } : {}),
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.limit  !== undefined ? { limit:  parsed.data.limit  } : {}),
      });
      res.json({ evaluations: rows, nextCursor });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/compliance/refresh', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      deps.bindingLookup.invalidate(r.tenantId);
      res.json({ ok: true, invalidated: r.tenantId });
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
  if (/already submitted|unique|duplicate/i.test(message)) {
    res.status(409).json({ error: 'conflict', message });
    return;
  }
  if (/invalid|bad request|exceeds|requires|unknown domain/i.test(message)) {
    res.status(400).json({ error: 'invalid_request', message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message });
}
