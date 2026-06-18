/**
 * templates.routes.ts — F.4.7 HTTP surface for the tenant template
 * catalog. Mounted at `/api/v1/tenants/:tenantId/templates`, cross-checked
 * against the JWT by `requireTenantParamMatchesJwt`.
 *
 *   GET /tenants/:tenantId/templates           — list active templates
 *   GET /tenants/:tenantId/templates/:slug     — template detail + invariants
 *
 * Templates are platform-curated (oweibo.tenant_templates has read_any
 * RLS), but the surface is still tenant-scoped so the admin pages have
 * a single URL convention. The TenantTemplateRegistry caches results
 * for 60s — admin updates flow through manually via SQL today.
 */
import { Router, type Response } from 'express';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { TenantTemplateRegistry } from '../../seed/TenantTemplateRegistry.js';

export interface TemplatesRouterDeps {
  readonly templates: TenantTemplateRegistry;
}

export function createTemplatesRouter(deps: TemplatesRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  router.get('/', async (_req, res) => {
    try {
      const templates = await deps.templates.list();
      res.json({ templates, count: templates.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/:slug', async (req, res) => {
    const slug = req.params['slug'] ?? '';
    try {
      const template = await deps.templates.get(slug);
      if (!template) {
        res.status(404).json({ error: 'not_found', message: `template ${slug} not found` });
        return;
      }
      res.json({ template });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  const message = err instanceof Error ? err.message : 'internal_error';
  res.status(500).json({ error: 'internal_error', message });
}
