/**
 * fabric.routes.ts — K.9 HTTP surface for the connector-fabric governance
 * planes. Mounted at `/api/v1/tenants/:tenantId/fabric/*`, cross-checked
 * against the JWT by `requireTenantParamMatchesJwt`.
 *
 *   GET  /policy                                — effective policy + version (ADR-006 §3.1)
 *   POST /policy/simulate                       — §3.6 dry-run impact report (pure read)
 *   POST /policy/propose                        — apply a tightening / refuse a relaxation
 *   GET  /connectors/:connectorId/deployment    — rollout state + effective mint version
 *   POST /connectors/:connectorId/rollout/canary   — begin cohort canary (ADR-004 §3.7)
 *   POST /connectors/:connectorId/rollout/promote  — target becomes active
 *   POST /connectors/:connectorId/rollout/rollback — re-tag queued, spare leased
 *
 * Deliberately ABSENT: an HTTP path that applies a relaxation. A route whose
 * body carries the approval votes would let one caller fabricate its own
 * "second approver" — dual control defeated by a JSON array (§22). Propose
 * answers `needs_dual_control` for relaxations; the apply leg ships when it
 * is wired through the MultiPartyApprovalService ballot flow, where each vote
 * is cast by its own authenticated principal. Fail-closed until then.
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
            'Relaxations require a second authorized approver (ADR-006 §3.4). ' +
            'The HTTP apply leg ships with the multi-party ballot wiring.',
        });
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
