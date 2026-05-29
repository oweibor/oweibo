/**
 * Tenant-layer management endpoints.
 *
 * GET  /api/v1/tenants/:tenantId/users              list members
 * POST /api/v1/tenants/:tenantId/users/invite        invite user
 * POST /api/v1/tenants/:tenantId/users/:userId/roles update member roles
 * DELETE /api/v1/tenants/:tenantId/users/:userId      remove member
 * GET  /api/v1/tenants/:tenantId/apikeys             list API keys
 * POST /api/v1/tenants/:tenantId/apikeys             create API key
 * POST /api/v1/tenants/:tenantId/apikeys/:id/revoke  revoke
 * GET  /api/v1/tenants/:tenantId/settings            get settings
 * PATCH /api/v1/tenants/:tenantId/settings           update settings
 */
import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes } from 'crypto';
import { withTenantContext, appendAudit } from '@oweibo/db';
import type { Principal } from '@oweibo/db';
import { authenticate, requireScopes } from '../middleware/authenticate.js';
import { audit } from '@oweibo/api-middleware';
import { expandRoles } from '../policy.js';

// T.5.b: autonomous-mode calibration gate.
//
// When a tenant admin attempts to set trustModeDefault='autonomous' AND the
// platform flag TENANT_CALIBRATION_GATE_AUTONOMOUS_ENABLED is on, the gate
// requires the tenant's global calibration score >= AUTONOMOUS_GATE_THRESHOLD.
// Otherwise responds 409 with the score and a remediation hint. ?force=true
// bypasses the gate and emits a separate audit row tenant.calibration.override.
//
// The score formula MIRRORS packages/core-engine CalibrationService.globalScore
// so identity does not need to depend on the full core-engine package. Both
// must stay in sync; see T.5.a for the canonical implementation.
const AUTONOMOUS_GATE_ENABLED = process.env['TENANT_CALIBRATION_GATE_AUTONOMOUS_ENABLED'] === 'true';
const AUTONOMOUS_GATE_THRESHOLD = 0.6;

async function computeGlobalCalibration(
  principal: Principal,
): Promise<{ score: number; summary: string; signals: Record<string, number | boolean> }> {
  const now = Date.now();
  return withTenantContext(principal, async (tx) => {
    const tenantRow = await tx.tenant.findUnique({
      where: { id: principal.ctx.tenantId },
      select: { createdAt: true },
    });
    const accountAgeDays = tenantRow
      ? Math.max(0, Math.min(30, Math.floor((now - tenantRow.createdAt.getTime()) / 86_400_000)))
      : 0;

    const completedCount = await tx.task.count({
      where: { tenantId: principal.ctx.tenantId, completedAt: { not: null } },
    });

    const bootstrap = await tx.tenantBootstrap.findUnique({
      where: { tenantId: principal.ctx.tenantId },
    });
    const bootstrapReady = bootstrap?.state === 'ready';

    const slotsRows = await tx.$queryRaw<{ count: bigint | number }[]>`
      SELECT COUNT(DISTINCT bae.slot_id) AS count
        FROM oweibo.bandit_arm_events bae
        JOIN oweibo.tasks t ON t.id::text = bae.task_id
       WHERE t.tenant_id = ${principal.ctx.tenantId}::uuid
    `;
    const slotsWithLearnedArms = Number(slotsRows[0]?.count ?? 0);

    // organicMemoryCount lives in Qdrant which identity does not reach; the
    // CalibrationService caller in core-engine injects a real counter.
    // Identity's gate treats it as 0 — conservative (lowers the score).
    const organicMemoryCount = 0;

    const score =
      0.20 * Math.min(accountAgeDays / 30, 1) +
      0.30 * Math.min(organicMemoryCount / 50, 1) +
      0.20 * Math.min(slotsWithLearnedArms / 8, 1) +
      0.20 * Math.min(completedCount / 25, 1) +
      0.10 * (bootstrapReady ? 1 : 0);

    const summary = score < 0.20 ? 'Brand new'
      : score < 0.40 ? 'Warming up'
      : score < 0.60 ? 'Adapting'
      : score < 0.85 ? 'Calibrated'
      : 'Fully calibrated';

    return {
      score,
      summary,
      signals: { accountAgeDays, completedCount, slotsWithLearnedArms, bootstrapReady },
    };
  });
}


const router = Router({ mergeParams: true });
router.use(authenticate);

// Resolve tenant context: principal must belong to this tenant, or be platform_admin
function resolveTenantPrincipal(req: any, tenantId: string): Principal | null {
  const p = req.principal as Principal | undefined;
  if (!p) return null;
  if (p.scopes.includes('platform:tenants:write')) {
    // platform_admin: inject tenant context
    return { ...p, ctx: { tenantId } };
  }
  if (p.ctx.tenantId !== tenantId) return null;
  return p;
}

function tenantGuard(req: any, res: any, next: any) {
  const tenantId = req.params.tenantId as string;
  const principal = resolveTenantPrincipal(req, tenantId);
  if (!principal) { res.status(404).json({ error: 'not_found' }); return; }
  req.principal = principal;
  next();
}

router.use(tenantGuard);

// ── Members ────────────────────────────────────────────────────────────────

router.get('/:tenantId/users',
  requireScopes('tenant:users:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const members = await withTenantContext(principal, tx =>
      tx.tenantMembership.findMany({
        where:   { tenantId: principal.ctx.tenantId },
        include: { user: true },
      })
    );
    res.json({ members });
  }
);

const InviteSchema = z.object({
  email: z.string().email(),
  roles: z.array(z.enum(['tenant_admin', 'tenant_developer', 'tenant_viewer'])).min(1),
});

router.post('/:tenantId/users/invite',
  requireScopes('tenant:users:write'),
  audit('tenant.member.invite', { resourceType: 'tenant_membership' }),
  async (req, res) => {
    const parsed = InviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;
    const { email, roles } = parsed.data;

    const membership = await withTenantContext(principal, async tx => {
      const user = await tx.user.findUnique({ where: { email } });
      if (!user) {
        res.status(404).json({ error: 'user_not_found', message: 'User must sign up first' });
        return null;
      }
      return tx.tenantMembership.upsert({
        where:  { userId_tenantId: { userId: user.id, tenantId: principal.ctx.tenantId } },
        create: { userId: user.id, tenantId: principal.ctx.tenantId, roles, invitedBy: principal.sub },
        update: { roles },
      });
    });
    if (!membership) return;
    res.status(201).json({ membership });
  }
);

const UpdateRolesSchema = z.object({
  roles: z.array(z.enum(['tenant_admin', 'tenant_developer', 'tenant_viewer'])).min(1),
});

router.post('/:tenantId/users/:userId/roles',
  requireScopes('tenant:users:write'),
  audit('tenant.member.roles', { resourceType: 'tenant_membership' }),
  async (req, res) => {
    const parsed = UpdateRolesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;
    const membership = await withTenantContext(principal, tx =>
      tx.tenantMembership.update({
        where: { userId_tenantId: { userId: req.params['userId']!, tenantId: principal.ctx.tenantId } },
        data:  { roles: parsed.data.roles },
      })
    );
    res.json({ membership });
  }
);

router.delete('/:tenantId/users/:userId',
  requireScopes('tenant:users:write'),
  audit('tenant.member.remove', { resourceType: 'tenant_membership' }),
  async (req, res) => {
    const principal = req.principal as Principal;
    await withTenantContext(principal, tx =>
      tx.tenantMembership.delete({
        where: { userId_tenantId: { userId: req.params['userId']!, tenantId: principal.ctx.tenantId } },
      })
    );
    res.status(204).send();
  }
);

// ── API Keys ───────────────────────────────────────────────────────────────

router.get('/:tenantId/apikeys',
  requireScopes('tenant:apikeys:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const keys = await withTenantContext(principal, tx =>
      tx.apiKey.findMany({
        where:  { tenantId: principal.ctx.tenantId, revokedAt: null },
        select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      })
    );
    res.json({ keys });
  }
);

const CreateApiKeySchema = z.object({
  name:      z.string().min(2).max(100),
  scopes:    z.array(z.string()).min(1),
  expiresAt: z.string().datetime().optional(),
});

router.post('/:tenantId/apikeys',
  requireScopes('tenant:apikeys:write'),
  audit('tenant.apikey.create', { resourceType: 'api_key' }),
  async (req, res) => {
    const parsed = CreateApiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;

    const rawSecret = `oweibo_ak_${randomBytes(32).toString('hex')}`;
    const prefix    = rawSecret.slice(0, 24);
    const hashed    = createHash('sha256').update(rawSecret).digest('hex');

    const key = await withTenantContext(principal, tx =>
      tx.apiKey.create({
        data: {
          id: uuidv4(),
          tenantId:         principal.ctx.tenantId,
          createdByUserId:  principal.sub,
          name:             parsed.data.name,
          prefix,
          hashedSecret:     hashed,
          scopes:           parsed.data.scopes,
          expiresAt:        parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        },
      })
    );

    // Return the raw secret ONCE; it cannot be recovered after this response
    res.status(201).json({
      key: { id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes, expiresAt: key.expiresAt },
      secret: rawSecret,
    });
  }
);

router.post('/:tenantId/apikeys/:id/revoke',
  requireScopes('tenant:apikeys:write'),
  audit('tenant.apikey.revoke', { resourceType: 'api_key' }),
  async (req, res) => {
    const principal = req.principal as Principal;
    const key = await withTenantContext(principal, tx =>
      tx.apiKey.update({
        where: { id: req.params['id'] },
        data:  { revokedAt: new Date() },
      })
    );
    res.json({ key: { id: key.id, revokedAt: key.revokedAt } });
  }
);

// ── Settings ───────────────────────────────────────────────────────────────

router.get('/:tenantId/settings',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const tenant = await withTenantContext(principal, tx =>
      tx.tenant.findUnique({
        where:  { id: principal.ctx.tenantId },
        select: { trustModeDefault: true, features: true, quotas: true },
      })
    );
    if (!tenant) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ settings: tenant });
  }
);

// T.5.c: read-only calibration endpoint backing the admin CalibrationBadge.
//   - Returns the score, threshold, summary, signals, and the flag state so
//     the badge can render different copy depending on whether the
//     autonomous gate is active.
//   - Uses the same scope as settings:read — anyone who can see the trust
//     mode can see the calibration that gates promoting it.
router.get('/:tenantId/calibration',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const calibration = await computeGlobalCalibration(principal);
    res.json({
      tenantId: principal.ctx.tenantId,
      score: calibration.score,
      threshold: AUTONOMOUS_GATE_THRESHOLD,
      summary: calibration.summary,
      signals: calibration.signals,
      gateEnabled: AUTONOMOUS_GATE_ENABLED,
      meetsAutonomousThreshold: calibration.score >= AUTONOMOUS_GATE_THRESHOLD,
    });
  }
);

// T.2.g: domain intake — read current state + submit interview answers.
//
// GET  /:tenantId/intake — current intake row or { state: 'absent' }.
// POST /:tenantId/intake — submit answers, transition state to 'requested'
//                          so the worker picks it up on the next pass.
router.get('/:tenantId/intake',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const intake = await withTenantContext(principal, tx =>
      tx.tenantDomainIntake.findUnique({ where: { tenantId: principal.ctx.tenantId } })
    );
    if (!intake) {
      res.json({ state: 'absent' });
      return;
    }
    res.json({
      state: intake.intakeState,
      classifiedDomain: intake.classifiedDomain,
      classifiedConfidence: intake.classifiedConfidence,
      recommendedTemplateSlug: intake.recommendedTemplateSlug,
      recommendedConnectors: intake.recommendedConnectors,
      recommendedSeedSkills: intake.recommendedSeedSkills,
      interviewAnswers: intake.interviewAnswers,
      completedAt: intake.completedAt,
    });
  }
);

const SubmitIntakeSchema = z.object({
  interviewAnswers: z.array(z.object({
    question: z.string().min(1).max(500),
    answer: z.string().min(1).max(5000),
  })).min(1).max(50),
});

router.post('/:tenantId/intake',
  requireScopes('tenant:settings:write'),
  audit('tenant.intake.submit', { resourceType: 'tenant' }),
  async (req, res) => {
    const parsed = SubmitIntakeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;
    const interviewAnswersJson = JSON.parse(JSON.stringify(parsed.data.interviewAnswers));
    const result = await withTenantContext(principal, tx =>
      tx.tenantDomainIntake.upsert({
        where: { tenantId: principal.ctx.tenantId },
        update: {
          intakeState: 'requested',
          interviewAnswers: interviewAnswersJson,
          startedAt: new Date(),
          updatedAt: new Date(),
        },
        create: {
          tenantId: principal.ctx.tenantId,
          intakeState: 'requested',
          interviewAnswers: interviewAnswersJson,
          startedAt: new Date(),
        },
      })
    );
    res.status(202).json({ state: result.intakeState });
  }
);

// T.2.f: list installed connector instances for a tenant. Credentials are
// never returned by this endpoint — only metadata that's safe to display in
// the admin UI. Credentials live in Vault and are read on demand by
// CredentialResolver at capability-invocation time.
router.get('/:tenantId/connectors',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const connectors = await withTenantContext(principal, tx =>
      tx.tenantConnector.findMany({
        where: { tenantId: principal.ctx.tenantId },
        orderBy: { installedAt: 'desc' },
        select: {
          id: true,
          connectorId: true,
          catalogVersion: true,
          instanceLabel: true,
          status: true,
          installedBy: true,
          installedAt: true,
          lastUsedAt: true,
          metadata: true,
        },
      })
    );
    res.json({ connectors });
  }
);

// T.7: catalog-update endpoints — admin reads the pending queue and resolves
// individual rows. Resolution writes are audited.
router.get('/:tenantId/catalog-updates',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const updates = await withTenantContext(principal, tx =>
      tx.tenantCatalogPendingUpdate.findMany({
        where: { tenantId: principal.ctx.tenantId, resolvedAt: null },
        orderBy: { detectedAt: 'desc' },
      })
    );
    res.json({ updates });
  }
);

const ResolveCatalogUpdateSchema = z.object({
  seedId: z.string().min(1).max(200),
  toContentHash: z.string().min(1).max(128),
  resolution: z.enum(['installed', 'dismissed']),
});

router.post('/:tenantId/catalog-updates/resolve',
  requireScopes('tenant:settings:write'),
  audit('tenant.catalog.update.resolve', { resourceType: 'tenant' }),
  async (req, res) => {
    const parsed = ResolveCatalogUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;
    const userId = principal.sub.startsWith('agent:') || principal.sub.startsWith('apikey:')
      ? null
      : principal.sub;
    const updated = await withTenantContext(principal, tx =>
      tx.tenantCatalogPendingUpdate.updateMany({
        where: {
          tenantId: principal.ctx.tenantId,
          seedId: parsed.data.seedId,
          toContentHash: parsed.data.toContentHash,
          resolvedAt: null,
        },
        data: {
          resolvedAt: new Date(),
          resolution: parsed.data.resolution,
          ...(userId ? { resolvedBy: userId } : {}),
        },
      })
    );
    res.json({ updated: updated.count });
  }
);

// T.2.h: read-only org-graph endpoint backing the admin org page.
// Returns nodes + outgoing edges as a flat list — graph rendering happens
// client-side. No mutation endpoints in this slice; writes happen through
// OrgGraphService (seeder pipeline) for now.
router.get('/:tenantId/org',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const out = await withTenantContext(principal, async (tx) => {
      const nodes = await tx.orgNode.findMany({
        where: { tenantId: principal.ctx.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const edges = await tx.orgEdge.findMany({
        where: { tenantId: principal.ctx.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      return { nodes, edges };
    });
    res.json(out);
  }
);

const UpdateSettingsSchema = z.object({
  trustModeDefault: z.enum(['supervised', 'graduated', 'autonomous']).optional(),
  features:         z.record(z.unknown()).optional(),
});

router.patch('/:tenantId/settings',
  requireScopes('tenant:settings:write'),
  audit('tenant.settings.update', { resourceType: 'tenant' }),
  async (req, res) => {
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;
    const force = req.query['force'] === 'true';

    // T.5.b: gate autonomous mode on calibration when the feature flag is on.
    if (
      parsed.data.trustModeDefault === 'autonomous'
      && AUTONOMOUS_GATE_ENABLED
      && !force
    ) {
      const calibration = await computeGlobalCalibration(principal);
      if (calibration.score < AUTONOMOUS_GATE_THRESHOLD) {
        res.status(409).json({
          error: 'calibration_required',
          score: calibration.score,
          threshold: AUTONOMOUS_GATE_THRESHOLD,
          summary: calibration.summary,
          signals: calibration.signals,
          hint: 'Add ?force=true to override (audited as tenant.calibration.override).',
        });
        return;
      }
    }

    // T.5.b: if the operator used ?force=true on the autonomous transition,
    // write a separate audit row so the override is independently visible
    // in the audit trail (the standard tenant.settings.update row from the
    // middleware also fires, but lacks the override context).
    if (parsed.data.trustModeDefault === 'autonomous' && force && AUTONOMOUS_GATE_ENABLED) {
      const calibration = await computeGlobalCalibration(principal);
      await appendAudit({
        id: uuidv4(),
        ts: new Date(),
        actorPrincipal: principal.sub,
        source: 'api',
        tenantId: principal.ctx.tenantId,
        scopeUsed: principal.scopes,
        action: 'tenant.calibration.override',
        resourceType: 'tenant',
        resourceId: principal.ctx.tenantId,
        outcome: 'allow',
        details: {
          score: calibration.score,
          threshold: AUTONOMOUS_GATE_THRESHOLD,
          summary: calibration.summary,
          reason: 'operator force override',
        },
      }).catch(() => undefined);
    }

    const tenant = await withTenantContext(principal, tx =>
      tx.tenant.update({
        where: { id: principal.ctx.tenantId },
        // Cast: Zod returns Record<string, unknown> on Json fields; Prisma's
        // narrower TenantUpdateInput requires InputJsonValue. Boundary cast.
        data:  parsed.data as unknown as Parameters<typeof tx.tenant.update>[0]['data'],
      })
    );
    res.json({ settings: { trustModeDefault: tenant.trustModeDefault, features: tenant.features } });
  }
);

// ── T.9: tenant lineage (parent-admin consent grants + lineage view) ──────

const CloneScopeEnum = z.enum([
  'memories', 'projects', 'org_graph', 'connectors_recommend', 'settings',
]);

const CreateGrantSchema = z.object({
  scopes: z.array(CloneScopeEnum).min(1).max(5),
  childSlugPrefix: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
  maxUses: z.number().int().min(1).max(100).optional(),
  /** ISO-8601; max 90 days out. */
  expiresAt: z.string().datetime(),
});

/**
 * Parent admin creates a consent grant. The platform_admin handler on the
 * tenant-create endpoint will only succeed if a valid grant exists.
 */
router.post('/:tenantId/lineage/grants',
  requireScopes('tenant:settings:write'),
  audit('tenant.lineage.grant.create', { resourceType: 'tenant' }),
  async (req, res) => {
    const parsed = CreateGrantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;
    if (principal.sub.startsWith('agent:') || principal.sub.startsWith('apikey:')) {
      res.status(403).json({ error: 'human_only' });
      return;
    }
    const expiresAt = new Date(parsed.data.expiresAt);
    const ninetyDaysOut = Date.now() + 90 * 24 * 60 * 60 * 1000;
    if (expiresAt.getTime() > ninetyDaysOut) {
      res.status(400).json({ error: 'expires_at_too_far' });
      return;
    }
    if (expiresAt.getTime() <= Date.now()) {
      res.status(400).json({ error: 'expires_at_in_past' });
      return;
    }
    const grant = await withTenantContext(principal, tx =>
      tx.tenantLineageConsentGrant.create({
        data: {
          parentTenantId: principal.ctx.tenantId,
          grantedByUserId: principal.sub,
          scopes: parsed.data.scopes,
          ...(parsed.data.childSlugPrefix ? { childSlugPrefix: parsed.data.childSlugPrefix } : {}),
          maxUses: parsed.data.maxUses ?? 1,
          expiresAt,
        },
      })
    );
    res.status(201).json({ grant });
  }
);

/** Parent admin lists own grants — for the lineage management UI. */
router.get('/:tenantId/lineage/grants',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const grants = await withTenantContext(principal, tx =>
      tx.tenantLineageConsentGrant.findMany({
        where: { parentTenantId: principal.ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
    );
    res.json({ grants });
  }
);

/** Parent admin revokes a grant. Already-consumed uses are not retracted. */
router.post('/:tenantId/lineage/grants/:id/revoke',
  requireScopes('tenant:settings:write'),
  audit('tenant.lineage.grant.revoke', { resourceType: 'tenant' }),
  async (req, res) => {
    const principal = req.principal as Principal;
    const updated = await withTenantContext(principal, tx =>
      tx.tenantLineageConsentGrant.updateMany({
        where: {
          id: req.params['id']!,
          parentTenantId: principal.ctx.tenantId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      })
    );
    if (updated.count === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ ok: true });
  }
);

/**
 * Lineage summary for the current tenant: own parent (if child) plus the
 * list of children (if parent). Both sides use the tenant's own
 * `app.tenant_id` scope; RLS policies on `tenant_lineage` allow each side
 * to read the rows that name them.
 */
router.get('/:tenantId/lineage',
  requireScopes('tenant:settings:read'),
  async (req, res) => {
    const principal = req.principal as Principal;
    const tenantId = principal.ctx.tenantId;
    const result = await withTenantContext(principal, async tx => {
      const asChild = await tx.tenantLineage.findUnique({ where: { childTenantId: tenantId } });
      const asParent = await tx.tenantLineage.findMany({
        where: { parentTenantId: tenantId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return { asChild, asParent };
    });
    res.json(result);
  }
);

export { expandRoles };
export default router;
