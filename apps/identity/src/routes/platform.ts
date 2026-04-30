/**
 * Platform-layer management endpoints.
 * All routes require platform_admin role (platform:tenants:write scope).
 *
 * GET  /api/v1/platform/tenants            list
 * POST /api/v1/platform/tenants            create
 * GET  /api/v1/platform/tenants/:id        get
 * PATCH /api/v1/platform/tenants/:id       update
 * POST /api/v1/platform/tenants/:id/suspend
 * GET  /api/v1/platform/users              list
 * POST /api/v1/platform/users/:id/roles    update platform roles
 */
import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { withTenantContext } from '@oweibo/db';
import type { Principal } from '@oweibo/db';
import { authenticate, requirePlatformAdmin } from '../middleware/authenticate.js';
import { audit } from '@oweibo/api-middleware';

const router = Router();
router.use(authenticate);
router.use(requirePlatformAdmin);

// ── Tenants ────────────────────────────────────────────────────────────────

router.get('/api/v1/platform/tenants', async (req, res) => {
  const principal = req.principal as Principal;
  const tenants = await withTenantContext(principal, tx =>
    tx.tenant.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  );
  res.json({ tenants });
});

const CreateTenantSchema = z.object({
  name:   z.string().min(2).max(100),
  slug:   z.string().min(2).max(50).regex(/^[a-z0-9-]+$/),
  quotas: z.record(z.unknown()).optional(),
  features: z.record(z.unknown()).optional(),
});

router.post('/api/v1/platform/tenants', audit('platform.tenant.create', { resourceType: 'tenant' }), async (req, res) => {
  const parsed = CreateTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
    return;
  }
  const principal = req.principal as Principal;
  const { name, slug, quotas, features } = parsed.data;

  const tenant = await withTenantContext(principal, tx =>
    tx.tenant.create({
      data: {
        id: uuidv4(),
        name,
        slug,
        quotas: quotas ?? {},
        features: features ?? {},
        createdBy: principal.sub.startsWith('agent:')
          ? (principal.actAs?.sub ?? null)
          : principal.sub.startsWith('apikey:') ? null : principal.sub,
      },
    })
  );
  res.status(201).json({ tenant });
});

router.get('/api/v1/platform/tenants/:id', async (req, res) => {
  const principal = req.principal as Principal;
  const tenant = await withTenantContext(principal, tx =>
    tx.tenant.findUnique({ where: { id: req.params['id'] } })
  );
  if (!tenant) { res.status(404).json({ error: 'not_found' }); return; }
  res.json({ tenant });
});

const UpdateTenantSchema = z.object({
  name:             z.string().min(2).max(100).optional(),
  status:           z.enum(['active', 'suspended', 'deleted']).optional(),
  trustModeDefault: z.enum(['supervised', 'graduated', 'autonomous']).optional(),
  features:         z.record(z.unknown()).optional(),
  quotas:           z.record(z.unknown()).optional(),
});

router.patch('/api/v1/platform/tenants/:id', audit('platform.tenant.update', { resourceType: 'tenant' }), async (req, res) => {
  const parsed = UpdateTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
    return;
  }
  const principal = req.principal as Principal;
  const tenant = await withTenantContext(principal, tx =>
    tx.tenant.update({ where: { id: req.params['id'] }, data: parsed.data })
  );
  res.json({ tenant });
});

router.post('/api/v1/platform/tenants/:id/suspend', audit('platform.tenant.suspend', { resourceType: 'tenant' }), async (req, res) => {
  const principal = req.principal as Principal;
  const tenant = await withTenantContext(principal, tx =>
    tx.tenant.update({ where: { id: req.params['id'] }, data: { status: 'suspended' } })
  );
  res.json({ tenant });
});

// ── Platform users ─────────────────────────────────────────────────────────

router.get('/api/v1/platform/users', async (req, res) => {
  const principal = req.principal as Principal;
  const users = await withTenantContext(principal, tx =>
    tx.user.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })
  );
  res.json({ users });
});

const UpdatePlatformRolesSchema = z.object({
  roles: z.array(z.enum(['platform_admin', 'platform_operator', 'platform_billing'])),
});

router.post('/api/v1/platform/users/:id/roles', audit('platform.user.roles', { resourceType: 'user' }), async (req, res) => {
  const parsed = UpdatePlatformRolesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
    return;
  }
  const principal = req.principal as Principal;
  const user = await withTenantContext(principal, tx =>
    tx.user.update({
      where: { id: req.params['id'] },
      data:  { platformRoles: parsed.data.roles },
    })
  );
  res.json({ user });
});

export default router;
