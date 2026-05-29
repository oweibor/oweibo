/**
 * connectors.routes.ts — F.4.7 HTTP surface for the connectors admin
 * page. Mounted at `/api/v1/tenants/:tenantId/connectors`, cross-checked
 * against the JWT by `requireTenantParamMatchesJwt`.
 *
 *   GET    /tenants/:tenantId/connectors                  — list installed
 *   GET    /tenants/:tenantId/connectors/recommendations  — by ?templateSlug=…
 *   POST   /tenants/:tenantId/connectors                  — install instance
 *
 * Read paths return rows directly from oweibo.tenant_connectors. The
 * recommendation endpoint composes the in-memory ConnectorRegistry with
 * the per-tenant domain bindings (when supplied) so domain-certified
 * connectors surface alongside template-matched ones.
 *
 * Install validates the body, optionally probes Vault, and writes a
 * tenant_connectors row in status='pending'. Duplicate-instance errors
 * surface as 409 conflict; vault-probe failures as 422
 * `credential_not_resolvable`.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/authenticate.js';
import { requireTenantParamMatchesJwt } from '../middleware/tenantParam.js';
import type { ConnectorRegistry } from '../../connector/ConnectorRegistry.js';
import type { PgTenantDomainBindingLookup } from '../../domain/PgTenantDomainBindingLookup.js';
import {
  CredentialNotResolvableError,
  DuplicateConnectorInstanceError,
  type PgTenantConnectorService,
} from '../../connector/PgTenantConnectorService.js';

// ── Schemas ──────────────────────────────────────────────────────────────

const RecommendQuery = z.object({
  templateSlug: z.string().min(1).max(120),
  minTier: z.enum(['experimental', 'community', 'verified', 'enterprise']).optional(),
});

const InstallBody = z.object({
  connectorId: z.string().min(1).max(120),
  catalogVersion: z.string().min(1).max(40),
  instanceLabel: z.string().min(1).max(120),
  vaultPath: z.string().min(1).max(500),
  metadata: z.record(z.unknown()).optional(),
});

// ── Router ───────────────────────────────────────────────────────────────

export interface ConnectorsRouterDeps {
  readonly catalog: ConnectorRegistry;
  readonly tenantConnectors: PgTenantConnectorService;
  /** Optional — when supplied, recommendations narrow by tenant domains. */
  readonly bindingLookup?: PgTenantDomainBindingLookup;
}

export function createConnectorsRouter(deps: ConnectorsRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.use(requireTenantParamMatchesJwt as unknown as import('express').RequestHandler);

  // ── List installed ────────────────────────────────────────────────────

  router.get('/', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    try {
      const connectors = await deps.tenantConnectors.listForTenant(r.tenantId);
      res.json({ connectors, count: connectors.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Recommendations ──────────────────────────────────────────────────
  // Mounted BEFORE / so the literal segment wins the match.

  router.get('/recommendations', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = RecommendQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const domainSlugs = deps.bindingLookup
        ? await deps.bindingLookup.forTenant(r.tenantId)
        : [];
      const recommendations = deps.catalog.recommendForDomain({
        templateSlug: parsed.data.templateSlug,
        domainSlugs,
        ...(parsed.data.minTier !== undefined ? { minTier: parsed.data.minTier } : {}),
      });
      res.json({
        templateSlug: parsed.data.templateSlug,
        domainSlugs,
        recommendations,
        count: recommendations.length,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  // ── Install instance ─────────────────────────────────────────────────

  router.post('/', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    const parsed = InstallBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    if (!deps.catalog.get(parsed.data.connectorId)) {
      res.status(404).json({
        error: 'unknown_connector',
        message: `connectorId ${parsed.data.connectorId} not found in the platform catalog`,
      });
      return;
    }
    try {
      const installed = await deps.tenantConnectors.install({
        tenantId: r.tenantId,
        connectorId: parsed.data.connectorId,
        catalogVersion: parsed.data.catalogVersion,
        instanceLabel: parsed.data.instanceLabel,
        vaultPath: parsed.data.vaultPath,
        installedBy: r.userId,
        ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}),
      });
      res.status(201).json({ connector: installed });
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

function handleError(err: unknown, res: Response): void {
  if (err instanceof CredentialNotResolvableError) {
    res.status(422).json({
      error: err.code,
      message: 'Vault probe returned empty or null at the supplied vaultPath',
      vaultPath: err.vaultPath,
    });
    return;
  }
  if (err instanceof DuplicateConnectorInstanceError) {
    res.status(409).json({
      error: err.code,
      message: err.message,
      connectorId: err.connectorId,
      instanceLabel: err.instanceLabel,
    });
    return;
  }
  const message = err instanceof Error ? err.message : 'internal_error';
  if (/not found/i.test(message)) {
    res.status(404).json({ error: 'not_found', message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message });
}
