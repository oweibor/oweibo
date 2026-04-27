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
import { withTenantContext } from '@oweibo/db';
import type { Principal } from '@oweibo/db';
import { authenticate, requireScopes } from '../middleware/authenticate.js';
import { expandRoles } from '../policy.js';

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
  async (req, res) => {
    const parsed = UpdateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
      return;
    }
    const principal = req.principal as Principal;
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
