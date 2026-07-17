/**
 * connectors.routes.ts — F.4.7 HTTP surface for the connectors admin
 * page. Mounted at `/api/v1/tenants/:tenantId/connectors`, cross-checked
 * against the JWT by `requireTenantParamMatchesJwt`.
 *
 *   GET    /tenants/:tenantId/connectors                  — list installed
 *   GET    /tenants/:tenantId/connectors/recommendations  — by ?templateSlug=…
 *   POST   /tenants/:tenantId/connectors                  — install instance
 *   POST   /tenants/:tenantId/connectors/custom           — register a custom manifest
 *   GET    /tenants/:tenantId/connectors/custom           — list custom manifests
 *   GET    /tenants/:tenantId/connectors/custom/:connectorId    — manifest detail
 *   DELETE /tenants/:tenantId/connectors/custom/:connectorId    — soft-disable
 *
 * Custom connectors: a tenant-authored manifest (customManifest.ts rules —
 * `custom.` id prefix, closed category set, no reserved action classes, no
 * uncertifiable support claims) that the install endpoint accepts exactly
 * like a platform catalog entry. Downstream governance is UNCHANGED: the
 * install-order gate, ADR-006 connector_enablement (absent ⇒ disabled, so
 * enabling one is a dual-controlled relaxation), and blue/green deployments
 * all apply to `custom.*` ids with no special cases.
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
import {
  DuplicateCustomConnectorError,
  type CustomConnectorService,
} from '../../connector/CustomConnectorService.js';
import { InvalidCustomManifestError } from '../../connector/customManifest.js';

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

// Shape-only here; the semantic rules (id prefix, closed category, reserved
// classes, MCP pairing) live in validateCustomManifest so they are testable
// as a pure contract and identical for every caller.
const CustomManifestBody = z.object({
  connectorId: z.string().min(1).max(120),
  displayName: z.string().min(1).max(200),
  category: z.string().min(1).max(40),
  description: z.string().min(1).max(4000),
  catalogVersion: z.string().min(1).max(40),
  credentialSchema: z.unknown(),
  capabilities: z.array(z.object({
    capabilityId: z.string().min(1).max(120),
    summary: z.string().min(1).max(500),
    actionClass: z.string().min(1).max(120),
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
  })).max(100).optional(),
  mcpServerUrl: z.string().max(2000).optional(),
  declaredTools: z.array(z.string().min(1).max(200)).max(256).optional(),
});

// ── Router ───────────────────────────────────────────────────────────────

export interface ConnectorsRouterDeps {
  readonly catalog: ConnectorRegistry;
  readonly tenantConnectors: PgTenantConnectorService;
  /** Optional — when supplied, recommendations narrow by tenant domains. */
  readonly bindingLookup?: PgTenantDomainBindingLookup;
  /** Optional — when absent, the custom endpoints answer 503 and install
   *  accepts only platform catalog ids (the pre-feature behavior). */
  readonly customConnectors?: CustomConnectorService;
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

  // ── Custom connector manifests ────────────────────────────────────────
  // Mounted BEFORE the install POST so the literal '/custom' segment wins.

  router.post('/custom', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    if (!deps.customConnectors) {
      res.status(503).json({ error: 'custom_connectors_unconfigured' });
      return;
    }
    const parsed = CustomManifestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const record = await deps.customConnectors.register({
        tenantId: r.tenantId,
        createdBy: r.userId,
        manifest: parsed.data as Parameters<CustomConnectorService['register']>[0]['manifest'],
      });
      res.status(201).json({ connector: record });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/custom', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    if (!deps.customConnectors) {
      res.status(503).json({ error: 'custom_connectors_unconfigured' });
      return;
    }
    try {
      const connectors = await deps.customConnectors.list(r.tenantId);
      res.json({ connectors, count: connectors.length });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/custom/:connectorId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    if (!deps.customConnectors) {
      res.status(503).json({ error: 'custom_connectors_unconfigured' });
      return;
    }
    try {
      const record = await deps.customConnectors.get(r.tenantId, req.params['connectorId'] ?? '');
      if (!record) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ connector: record });
    } catch (err) {
      handleError(err, res);
    }
  });

  router.delete('/custom/:connectorId', async (req, res) => {
    const r = req as unknown as AuthenticatedRequest;
    if (!deps.customConnectors) {
      res.status(503).json({ error: 'custom_connectors_unconfigured' });
      return;
    }
    try {
      const disabled = await deps.customConnectors.disable(r.tenantId, req.params['connectorId'] ?? '');
      if (!disabled) {
        res.status(404).json({ error: 'not_found_or_already_disabled' });
        return;
      }
      res.status(204).end();
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
    // Platform catalog first; then the tenant's registered custom manifests.
    // A DISABLED custom manifest is not installable (installable() checks).
    if (!deps.catalog.get(parsed.data.connectorId)) {
      const customOk = deps.customConnectors
        ? await deps.customConnectors.installable(r.tenantId, parsed.data.connectorId)
        : false;
      if (!customOk) {
        res.status(404).json({
          error: 'unknown_connector',
          message: `connectorId ${parsed.data.connectorId} not found in the platform catalog or the tenant's registered custom connectors`,
        });
        return;
      }
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
  if (err instanceof InvalidCustomManifestError) {
    res.status(400).json({ error: err.code, violations: err.violations });
    return;
  }
  if (err instanceof DuplicateCustomConnectorError) {
    res.status(409).json({ error: err.code, message: err.message, connectorId: err.connectorId });
    return;
  }
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
