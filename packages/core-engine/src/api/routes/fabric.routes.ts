/**
 * fabric.routes.ts — K.9 HTTP surface for the connector-fabric governance
 * planes. Mounted at `/api/v1/tenants/:tenantId/fabric/*`, cross-checked
 * against the JWT by `requireTenantParamMatchesJwt`.
 *
 *   GET  /policy                                — effective policy + version (ADR-006 §3.1)
 *   POST /policy/simulate                       — §3.6 dry-run impact report (pure read)
 *   POST /policy/propose                        — tightening applies; relaxation opens a ballot
 *   GET  /policy/relaxations                    — pending relaxation ballots
 *   GET  /policy/relaxations/:proposalId        — one ballot + its vote tally
 *   POST /policy/relaxations/:proposalId/votes  — cast the AUTHENTICATED principal's vote
 *   GET  /connectors/:connectorId/deployment    — rollout state + effective mint version
 *   POST /connectors/:connectorId/rollout/canary   — begin cohort canary (ADR-004 §3.7)
 *   POST /connectors/:connectorId/rollout/promote  — target becomes active
 *   POST /connectors/:connectorId/rollout/rollback — re-tag queued, spare leased
 *
 * Dual-control shape (ADR-006 §3.4): there is still NO route that applies a
 * relaxation directly, and the vote route carries NO voter identity and NO
 * onBehalfOf — each vote is the JWT principal's own, so a "second approver"
 * can only ever be a second authenticated human. The apply happens server-
 * side inside PolicyRelaxationFlow when the floor quorum is reached.
 *
 * The proposer is ALWAYS the authenticated principal (JWT userId), never a
 * body field — quorum arithmetic counts the proposer as at most one vote, so
 * letting a caller name someone else as proposer would smuggle a free vote.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { TenantPolicyService } from '../../fabric/policy/TenantPolicyService.js';
import type { PolicyRelaxationFlow } from '../../fabric/policy/PolicyRelaxationFlow.js';
import type { ConnectorUpgradeService } from '../../fabric/upgrade/ConnectorUpgradeService.js';
import { DIMENSION_CATEGORY, type PolicyDimension } from '../../fabric/policy/contract.js';
import { effectiveJobVersion } from '../../fabric/upgrade/rolloutContract.js';

// ── Zod schemas ─────────────────────────────────────────────────────────

// The PolicyValue union, one branch per ADR-006 §3.1 dimension.
const PolicyValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('data_persistence'), allowed: z.boolean() }),
  z.object({ kind: z.literal('indexing_scope'), scope: z.enum(['metadata', 'full_content']) }),
  z.object({ kind: z.literal('connector_enablement'), enabled: z.record(z.string(), z.boolean()) }),
  z.object({ kind: z.literal('operation_permissions'), liveRead: z.boolean(), liveWrite: z.boolean() }),
  z.object({ kind: z.literal('data_residency'), region: z.string() }),
  z.object({ kind: z.literal('classification_exclusions'), excludeTags: z.array(z.string()).max(200) }),
  z.object({ kind: z.literal('freshness_sla'), maxAgeMs: z.record(z.string(), z.number().int().nonnegative()) }),
  z.object({
    kind: z.literal('retrieval_preference'),
    mode: z.record(z.string(), z.enum(['index', 'live', 'hybrid'])),
  }),
]);

const ChangeSetBody = z.object({
  changes: z
    .array(z.object({ dimension: z.string().min(1), value: PolicyValueSchema }))
    .min(1)
    .max(8),
});

const CanaryBody = z.object({
  targetVersion: z.string().min(1).max(64),
  canaryCohort: z.string().min(1).max(128),
});

const VoteBody = z.object({
  vote: z.enum(['approve', 'reject']),
  comment: z.string().max(2000).optional(),
});

/** dimension must be a real dimension AND match its value's kind — a mismatch
 *  would let a value be classified under one lattice and stored under another. */
function validateChanges(body: z.infer<typeof ChangeSetBody>):
  | { ok: true; changes: { dimension: PolicyDimension; value: z.infer<typeof PolicyValueSchema> }[] }
  | { ok: false; detail: string } {
  const out: { dimension: PolicyDimension; value: z.infer<typeof PolicyValueSchema> }[] = [];
  for (const c of body.changes) {
    if (!(c.dimension in DIMENSION_CATEGORY)) {
      return { ok: false, detail: `unknown dimension: ${c.dimension}` };
    }
    if (c.value.kind !== c.dimension) {
      return { ok: false, detail: `value kind ${c.value.kind} does not match dimension ${c.dimension}` };
    }
    out.push({ dimension: c.dimension as PolicyDimension, value: c.value });
  }
  return { ok: true, changes: out };
}

// ── Router ───────────────────────────────────────────────────────────────

export interface FabricRouterDeps {
  readonly policy: TenantPolicyService;
  readonly upgrade: ConnectorUpgradeService;
  /** When absent, propose still refuses relaxations (409) and the ballot
   *  endpoints answer 503 — fail-closed, never fail-open. */
  readonly relaxations?: PolicyRelaxationFlow;
}

export function createFabricRouter(deps: FabricRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  // ── Policy plane (ADR-006) ─────────────────────────────────────────────

  router.get('/policy', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const [policy, version] = await Promise.all([
        deps.policy.effectivePolicy(r.tenantId),
        deps.policy.currentVersion(r.tenantId),
      ]);
      const dimensions = Object.entries(policy).map(([dimension, value]) => ({
        dimension,
        category: DIMENSION_CATEGORY[dimension as PolicyDimension],
        value,
      }));
      res.json({ policyVersion: version, dimensions });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/policy/simulate', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = ChangeSetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues });
      return;
    }
    const v = validateChanges(parsed.data);
    if (!v.ok) {
      res.status(400).json({ error: 'invalid_change', detail: v.detail });
      return;
    }
    try {
      const report = await deps.policy.simulate({
        tenantId: r.tenantId,
        proposerId: r.userId,
        changes: v.changes,
      });
      res.json(report);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/policy/propose', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = ChangeSetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues });
      return;
    }
    const v = validateChanges(parsed.data);
    if (!v.ok) {
      res.status(400).json({ error: 'invalid_change', detail: v.detail });
      return;
    }
    try {
      // With the ballot flow wired, a relaxation opens a durable ballot the
      // second approver can vote on. Without it, fail-closed 409 as before.
      if (deps.relaxations) {
        const result = await deps.relaxations.propose({
          tenantId: r.tenantId,
          proposerId: r.userId,
          changes: v.changes,
        });
        if (result.kind === 'pending_approval') {
          res.status(202).json(result);
          return;
        }
        res.json(result);
        return;
      }
      const result = await deps.policy.propose({
        tenantId: r.tenantId,
        proposerId: r.userId,
        changes: v.changes,
      });
      if (result.kind === 'needs_dual_control') {
        // 409: the proposal is understood but cannot apply single-handed.
        res.status(409).json({
          error: 'needs_dual_control',
          classification: result.classification,
          quorum: result.quorum,
          detail:
            'Relaxations require a second authorized approver (ADR-006 §3.4); ' +
            'the ballot flow is not configured on this deployment.',
        });
        return;
      }
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Relaxation ballots (ADR-006 §3.4, through the shipped vote ledger) ──

  router.get('/policy/relaxations', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    if (!deps.relaxations) {
      res.status(503).json({ error: 'relaxation_flow_unconfigured' });
      return;
    }
    try {
      const pending = await deps.relaxations.listPending(r.tenantId);
      res.json({ proposals: pending, count: pending.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/policy/relaxations/:proposalId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    if (!deps.relaxations) {
      res.status(503).json({ error: 'relaxation_flow_unconfigured' });
      return;
    }
    try {
      const status = await deps.relaxations.status(r.tenantId, req.params['proposalId'] ?? '');
      if (!status) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(status);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/policy/relaxations/:proposalId/votes', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    if (!deps.relaxations) {
      res.status(503).json({ error: 'relaxation_flow_unconfigured' });
      return;
    }
    // §3.4 rule 2 — no delegation on this surface, structurally: the field
    // is rejected outright rather than ignored, so a client cannot even
    // BELIEVE it voted on someone's behalf.
    if (req.body && typeof req.body === 'object' && 'onBehalfOf' in req.body) {
      res.status(400).json({
        error: 'delegation_prohibited',
        detail: 'Relaxation votes are cast only as the authenticated principal (ADR-006 §3.4).',
      });
      return;
    }
    const parsed = VoteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues });
      return;
    }
    try {
      const result = await deps.relaxations.vote({
        tenantId: r.tenantId,
        proposalId: req.params['proposalId'] ?? '',
        voterUserId: r.userId, // ALWAYS the JWT principal — never a body field
        vote: parsed.data.vote,
        ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment } : {}),
      });
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (result.kind === 'already_resolved') {
        res.status(409).json({ error: 'already_resolved', state: result.state });
        return;
      }
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Rollout plane (ADR-004 §3.7) ───────────────────────────────────────

  router.get('/connectors/:connectorId/deployment', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const connectorId = req.params['connectorId'] ?? '';
    try {
      const d = await deps.upgrade.deployment(r.tenantId, connectorId);
      if (!d) {
        res.status(404).json({ error: 'not_registered', connectorId });
        return;
      }
      res.json({ deployment: d, mintVersion: effectiveJobVersion(d) });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/connectors/:connectorId/rollout/canary', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const connectorId = req.params['connectorId'] ?? '';
    const parsed = CanaryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues });
      return;
    }
    try {
      const out = await deps.upgrade.beginCanary(r.tenantId, {
        connectorId,
        targetVersion: parsed.data.targetVersion,
        canaryCohort: parsed.data.canaryCohort,
      });
      if (!out.ok) {
        res.status(out.error === 'not_registered' ? 404 : 409).json({ error: out.error });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/connectors/:connectorId/rollout/promote', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const connectorId = req.params['connectorId'] ?? '';
    try {
      const out = await deps.upgrade.promote(r.tenantId, connectorId);
      if (!out.ok) {
        res.status(out.error === 'not_registered' ? 404 : 409).json({ error: out.error });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/connectors/:connectorId/rollout/rollback', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const connectorId = req.params['connectorId'] ?? '';
    try {
      const out = await deps.upgrade.rollback(r.tenantId, connectorId);
      if (!out.ok) {
        res.status(out.error === 'not_registered' ? 404 : 409).json({ error: out.error });
        return;
      }
      res.json({ ok: true, retagged: out.retagged });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: 'internal_error', message });
}
