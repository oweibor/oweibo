/**
 * T.2.e: tenant bootstrap UX hook.
 *
 * GET /api/v1/tenants/:tenantId/bootstrap
 *
 * Returns the current tenant_bootstrap row plus an array of per-step status
 * entries from tenant_bootstrap_steps. The admin UI renders this as a small
 * onboarding banner — "5/5 steps complete (ready)" or "3/5 (running) — some
 * features may be limited".
 *
 * Auth: same tenantGuard pattern as the rest of /api/v1/tenants/* — the
 * caller must belong to the tenant (or be platform_admin acting on its
 * behalf). RLS in withTenantContext enforces isolation; this route never
 * returns rows from another tenant.
 *
 * Backwards compatibility: tenants that predate T.0 have no
 * tenant_bootstrap row. The endpoint returns { state: 'absent' } so the
 * admin UI can render a sensible "onboarding not initialized" hint
 * instead of 404-ing.
 */
import { Router } from 'express';
import { withTenantContext } from '@oweibo/db';
import type { Principal } from '@oweibo/db';
import { authenticate } from '../middleware/authenticate.js';

const router = Router({ mergeParams: true });
router.use(authenticate);

function resolveTenantPrincipal(req: { principal?: Principal }, tenantId: string): Principal | null {
  const p = req.principal;
  if (!p) return null;
  if (p.scopes.includes('platform:tenants:write')) {
    return { ...p, ctx: { tenantId } };
  }
  if (p.ctx.tenantId !== tenantId) return null;
  return p;
}

router.get('/api/v1/tenants/:tenantId/bootstrap', async (req, res) => {
  const tenantId = req.params['tenantId'] as string;
  const principal = resolveTenantPrincipal(req as { principal?: Principal }, tenantId);
  if (!principal) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const out = await withTenantContext(principal, async (tx) => {
    const bootstrap = await tx.tenantBootstrap.findUnique({ where: { tenantId } });
    if (!bootstrap) {
      return { state: 'absent' as const };
    }
    const steps = await tx.tenantBootstrapStep.findMany({
      where: { tenantId },
      orderBy: { stepName: 'asc' },
    });

    const total = steps.length;
    const done = steps.filter((s) => s.status === 'ok' || s.status === 'skipped').length;
    const failed = steps.filter((s) => s.status === 'failed').length;

    return {
      state: bootstrap.state,
      templateSlug: bootstrap.templateSlug,
      attempts: bootstrap.attempts,
      lastError: bootstrap.lastError,
      startedAt: bootstrap.startedAt,
      completedAt: bootstrap.completedAt,
      createdAt: bootstrap.createdAt,
      updatedAt: bootstrap.updatedAt,
      progress: { done, total, failed },
      steps: steps.map((s) => ({
        name: s.stepName,
        status: s.status,
        attempts: s.attempts,
        lastError: s.lastError,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
      })),
    };
  });

  res.json(out);
});

export default router;
