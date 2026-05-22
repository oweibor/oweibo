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
        data:  parsed.data,
      })
    );
    res.json({ settings: { trustModeDefault: tenant.trustModeDefault, features: tenant.features } });
  }
);

export { expandRoles };
export default router;
