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
import { createHash } from 'crypto';
import { withTenantContext } from '@oweibo/db';
import type { Principal } from '@oweibo/db';
import { authenticate, requirePlatformAdmin } from '../middleware/authenticate.js';
import { audit } from '@oweibo/api-middleware';
import {
  TENANT_CREATED_V1_SUBJECT,
  type TenantCreatedV1Payload,
} from '@oweibo/core-contracts';

/**
 * T.5.e: deterministic seed-cohort assignment.
 *
 * SHA256(tenantId) mod 2: half of newly created tenants go into 'control'
 * (no seed memories installed by T.2.a), half go into 'seeded' (full
 * install). The split is uniform over valid UUIDs and reproducible across
 * processes.
 *
 * Behavior is identical to packages/core-engine SeedCohortAssigner — the
 * code is duplicated here to avoid pulling the full core-engine package
 * into the identity service. Both must stay in sync.
 *
 * Flag SEED_AB_ENABLED=true activates the cohorting. When off (default),
 * every tenant lands in 'seeded'.
 */
type SeedCohort = 'seeded' | 'control' | 'exempt';

function seedAbEnabled(): boolean {
  return process.env['SEED_AB_ENABLED'] === 'true';
}

function assignSeedCohort(tenantId: string, override?: SeedCohort): SeedCohort {
  if (override) return override;
  if (!seedAbEnabled()) return 'seeded';
  const digest = createHash('sha256').update(tenantId).digest();
  return (digest[0]! & 1) === 0 ? 'seeded' : 'control';
}

const router = Router();
router.use(authenticate);
router.use(requirePlatformAdmin);

// ── T.6: tenant templates catalog ──────────────────────────────────────────
// Read-only list endpoint used by the admin tenant-create dropdown and any
// future programmatic consumer. Writes flow through SQL / a follow-up
// admin form, not this route.
router.get('/api/v1/platform/templates', async (req, res) => {
  const principal = req.principal as Principal;
  const templates = await withTenantContext(principal, tx =>
    tx.tenantTemplate.findMany({
      where: { active: true },
      orderBy: [{ slug: 'asc' }],
    })
  );
  res.json({ templates });
});

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
  /** T.0: optional bootstrap template; defaults to 'default'. T.6 expands the catalog. */
  templateSlug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
  /** T.5.e: optional cohort override. Used for internal/synthetic tenants
   *  the platform team wants excluded from the A/B trial via 'exempt'. */
  seedCohort: z.enum(['seeded', 'control', 'exempt']).optional(),
  /** T.9: parent tenant for lineage. When supplied, parentConsentGrantId
   *  MUST also be supplied — the handler atomically claims the grant
   *  inside the create transaction. The lineage_enabled flag gates the
   *  feature; when off, supplying these fields produces 400. */
  parentTenantId: z.string().uuid().optional(),
  parentConsentGrantId: z.string().uuid().optional(),
});

/**
 * T.9: lineage feature flag. When false, supplying parentTenantId is a 400.
 * Platform-wide flag — wired from env so it can be flipped without redeploy
 * the way other TTV flags are.
 */
function tenantLineageEnabled(): boolean {
  return process.env['TENANT_LINEAGE_ENABLED'] === 'true';
}

/**
 * T.0: bootstrap feature flag. When false, the tenant_bootstrap row is created
 * with state='disabled' and no outbox event is emitted — preserves the pre-T.0
 * behaviour byte-for-byte. Defaults to true (new behaviour on).
 */
function bootstrapEnabled(): boolean {
  return process.env['TENANT_BOOTSTRAP_ENABLED'] !== 'false';
}

router.post('/api/v1/platform/tenants', audit('platform.tenant.create', { resourceType: 'tenant' }), async (req, res) => {
  const parsed = CreateTenantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', issues: parsed.error.flatten() });
    return;
  }
  const principal = req.principal as Principal;
  const {
    name, slug, quotas, features, templateSlug,
    seedCohort: cohortOverride,
    parentTenantId, parentConsentGrantId,
  } = parsed.data;
  const enabled = bootstrapEnabled();
  const effectiveTemplate = templateSlug ?? 'default';

  // T.9: validate lineage fields *before* the transaction so a flag-off
  // request fails fast without consuming any DB writes.
  const wantsLineage = Boolean(parentTenantId || parentConsentGrantId);
  if (wantsLineage) {
    if (!tenantLineageEnabled()) {
      res.status(400).json({ error: 'lineage_disabled' });
      return;
    }
    if (!parentTenantId || !parentConsentGrantId) {
      res.status(400).json({ error: 'lineage_requires_parent_and_grant' });
      return;
    }
  }

  let createdTenant;
  try {
    createdTenant = await withTenantContext(principal, async tx => {
    // T.9: atomic grant claim — compare-and-set UPDATE inside the same
    // transaction as the tenant INSERT. The UPDATE acquires a row exclusive
    // lock so concurrent claims serialize. Zero rows returned ⇒ grant is
    // exhausted / expired / revoked / wrong parent.
    let lineageScopes: readonly string[] | null = null;
    if (wantsLineage) {
      const claim = await tx.$queryRaw<Array<{
        id: string;
        parent_tenant_id: string;
        scopes: string[];
        child_slug_prefix: string | null;
      }>>`
        UPDATE oweibo.tenant_lineage_consent_grants
           SET uses        = uses + 1,
               consumed_at = CASE WHEN uses + 1 >= max_uses THEN NOW() ELSE consumed_at END
         WHERE id          = ${parentConsentGrantId}::uuid
           AND parent_tenant_id = ${parentTenantId}::uuid
           AND uses        < max_uses
           AND expires_at  > NOW()
           AND consumed_at IS NULL
           AND revoked_at  IS NULL
         RETURNING id, parent_tenant_id, scopes, child_slug_prefix`;
      if (claim.length === 0) {
        throw Object.assign(new Error('grant_unavailable'), { status: 400 });
      }
      const grant = claim[0]!;
      // Validate slug prefix if the grant restricts it.
      if (grant.child_slug_prefix && !slug.startsWith(grant.child_slug_prefix)) {
        throw Object.assign(new Error('grant_slug_prefix_mismatch'), { status: 400 });
      }
      lineageScopes = grant.scopes;
    }

    // 1. Original tenant row — unchanged shape.
    const created = await tx.tenant.create({
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
    });

    // 2. tenant_settings — default row for downstream features to populate.
    await tx.tenantSettings.create({
      data: { tenantId: created.id },
    });

    // 3. tenant_bootstrap — lifecycle state. 'disabled' when flag is off so the
    //    row is still present (lets the worker know the tenant predated T.0).
    // T.5.e: seedCohort assigned deterministically; cohortOverride allows
    //    platform admins to flag internal/synthetic tenants as 'exempt'.
    const cohort = assignSeedCohort(created.id, cohortOverride);
    await tx.tenantBootstrap.create({
      data: {
        tenantId: created.id,
        state: enabled ? 'pending' : 'disabled',
        templateSlug: effectiveTemplate,
        seedCohort: cohort,
      },
    });

    // 3.5 T.9: lineage row — created after tenant + bootstrap so FK targets
    //          resolve. The cycle-check trigger on the table walks the
    //          parent chain; insert is atomic with the grant claim.
    if (wantsLineage && lineageScopes) {
      await tx.tenantLineage.create({
        data: {
          childTenantId: created.id,
          parentTenantId: parentTenantId!,
          consentGrantId: parentConsentGrantId!,
          clonedScopes: lineageScopes as string[],
        },
      });
    }

    // 4. outbox — atomic with the tenant insert; OutboxRelay drains async.
    if (enabled) {
      const payload: TenantCreatedV1Payload = {
        schemaVersion: '1',
        tenantId: created.id,
        slug: created.slug,
        templateSlug: effectiveTemplate,
        createdBy: created.createdBy,
        createdAt: created.createdAt.toISOString(),
      };
      // Prisma's InputJsonValue rejects readonly types; round-trip through JSON
      // to strip the readonly modifiers from TenantCreatedV1Payload.
      await tx.outbox.create({
        data: {
          id: uuidv4(),
          subject: TENANT_CREATED_V1_SUBJECT,
          payload: JSON.parse(JSON.stringify(payload)),
        },
      });
    }

    return created;
    });
  } catch (err) {
    const status = (err && typeof err === 'object' && 'status' in err
      && typeof (err as { status: unknown }).status === 'number')
      ? (err as { status: number }).status
      : 500;
    const message = err instanceof Error ? err.message : 'internal_error';
    if (status === 400) {
      res.status(400).json({ error: message });
      return;
    }
    throw err;
  }
  res.status(201).json({ tenant: createdTenant });
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
