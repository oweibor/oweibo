/**
 * F.4.7: connectors routes integration tests.
 *
 * Covers:
 *   - GET / lists installed rows.
 *   - GET /recommendations validates body and composes domain + template
 *     paths via ConnectorRegistry.recommendForDomain.
 *   - POST / validates body, surfaces 404 for unknown connector, 201 on
 *     install, 409 on duplicate, 422 on credential probe failure.
 *   - Tenant cross-check 403.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createConnectorsRouter } from '../connectors.routes.js';
import {
  CredentialNotResolvableError,
  DuplicateConnectorInstanceError,
} from '../../../connector/PgTenantConnectorService.js';

function stubAuth(jwtTenantId: string, userId = 'cccccccc-3333-4333-c333-cccccccccccc') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as unknown as Record<string, unknown>;
    r['tenantId'] = jwtTenantId;
    r['userId']   = userId;
    r['scopes']   = [];
    next();
  };
}

const TENANT = '11111111-1111-4111-a111-111111111111';
const OTHER  = '22222222-2222-4222-b222-222222222222';

const INSTALLED = {
  id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
  connectorId: 'github-issues',
  catalogVersion: '1.0.0',
  instanceLabel: 'primary',
  status: 'pending',
  installedBy: null,
  installedAt: '2026-05-29T00:00:00.000Z',
  lastUsedAt: null,
  vaultPath: 'tenants/x/connectors/y',
  metadata: {},
};

function makeStubs() {
  const catalog = {
    get: jest.fn().mockImplementation((id: string) =>
      id === 'github-issues' ? { connectorId: id, displayName: 'GitHub Issues' } : null),
    recommend: jest.fn().mockReturnValue([{ connectorId: 'a' }, { connectorId: 'b' }]),
    recommendForDomain: jest.fn().mockReturnValue([
      { connectorId: 'github-issues', recommendedFor: ['*'] },
    ]),
    all: jest.fn().mockReturnValue([]),
    getCapability: jest.fn(),
    size: 1,
  };
  const tenantConnectors = {
    listForTenant: jest.fn().mockResolvedValue([INSTALLED]),
    install:       jest.fn().mockResolvedValue(INSTALLED),
  };
  const bindingLookup = {
    forTenant: jest.fn().mockResolvedValue(['fintech', 'healthcare']),
    invalidate: jest.fn(),
    invalidateAll: jest.fn(),
  };
  const CUSTOM = {
    id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
    connectorId: 'custom.acme-tracker',
    displayName: 'Acme Tracker',
    category: 'custom',
    status: 'registered',
    certificationTarget: 'experimental',
  };
  const customConnectors = {
    register:    jest.fn().mockResolvedValue(CUSTOM),
    list:        jest.fn().mockResolvedValue([CUSTOM]),
    get:         jest.fn().mockResolvedValue(CUSTOM),
    // Default FALSE so the long-standing unknown-connector 404 pin holds;
    // the custom-install test flips it per-case.
    installable: jest.fn().mockResolvedValue(false),
    disable:     jest.fn().mockResolvedValue(true),
  };
  return { catalog, tenantConnectors, bindingLookup, customConnectors };
}

function makeApp(jwtTenant: string, withBindings = true, withCustom = true) {
  const stubs = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/connectors', createConnectorsRouter({
    catalog:          stubs.catalog          as unknown as Parameters<typeof createConnectorsRouter>[0]['catalog'],
    tenantConnectors: stubs.tenantConnectors as unknown as Parameters<typeof createConnectorsRouter>[0]['tenantConnectors'],
    ...(withBindings
      ? { bindingLookup: stubs.bindingLookup as unknown as Parameters<typeof createConnectorsRouter>[0]['bindingLookup'] }
      : {}),
    ...(withCustom
      ? { customConnectors: stubs.customConnectors as unknown as NonNullable<Parameters<typeof createConnectorsRouter>[0]['customConnectors']> }
      : {}),
  }));
  return { app, ...stubs };
}

describe('F.4.7: connectors routes', () => {
  // ── List ────────────────────────────────────────────────────────────────
  it('GET /connectors returns installed rows', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/connectors`);
    expect(res.status).toBe(200);
    expect(res.body.connectors).toHaveLength(1);
    expect(res.body.count).toBe(1);
    expect(tenantConnectors.listForTenant).toHaveBeenCalledWith(TENANT);
  });

  // ── Recommendations ─────────────────────────────────────────────────────
  it('GET /connectors/recommendations requires templateSlug', async () => {
    const supertest = (await import('supertest')).default;
    const { app, catalog } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/connectors/recommendations`);
    expect(res.status).toBe(400);
    expect(catalog.recommendForDomain).not.toHaveBeenCalled();
  });

  it('GET /connectors/recommendations composes domain + template paths', async () => {
    const supertest = (await import('supertest')).default;
    const { app, catalog, bindingLookup } = makeApp(TENANT);
    const res = await supertest(app)
      .get(`/tenants/${TENANT}/connectors/recommendations?templateSlug=fintech-core`);
    expect(res.status).toBe(200);
    expect(res.body.templateSlug).toBe('fintech-core');
    expect(res.body.domainSlugs).toEqual(['fintech', 'healthcare']);
    expect(res.body.recommendations).toHaveLength(1);
    expect(bindingLookup.forTenant).toHaveBeenCalledWith(TENANT);
    expect(catalog.recommendForDomain).toHaveBeenCalledWith({
      templateSlug: 'fintech-core',
      domainSlugs: ['fintech', 'healthcare'],
    });
  });

  it('GET /connectors/recommendations works without a binding lookup', async () => {
    const supertest = (await import('supertest')).default;
    const { app, catalog } = makeApp(TENANT, /*withBindings=*/ false);
    const res = await supertest(app)
      .get(`/tenants/${TENANT}/connectors/recommendations?templateSlug=fintech-core`);
    expect(res.status).toBe(200);
    expect(res.body.domainSlugs).toEqual([]);
    expect(catalog.recommendForDomain).toHaveBeenCalledWith({
      templateSlug: 'fintech-core',
      domainSlugs: [],
    });
  });

  it('GET /connectors/recommendations passes minTier through', async () => {
    const supertest = (await import('supertest')).default;
    const { app, catalog } = makeApp(TENANT);
    await supertest(app)
      .get(`/tenants/${TENANT}/connectors/recommendations?templateSlug=fintech-core&minTier=enterprise`);
    expect(catalog.recommendForDomain).toHaveBeenCalledWith(expect.objectContaining({
      minTier: 'enterprise',
    }));
  });

  // ── Install ────────────────────────────────────────────────────────────
  it('POST /connectors returns 201 + the installed row', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({
        connectorId: 'github-issues',
        catalogVersion: '1.0.0',
        instanceLabel: 'primary',
        vaultPath: 'tenants/x/connectors/y',
      });
    expect(res.status).toBe(201);
    expect(res.body.connector.connectorId).toBe('github-issues');
    expect(tenantConnectors.install).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      connectorId: 'github-issues',
      installedBy: 'cccccccc-3333-4333-c333-cccccccccccc',
    }));
  });

  it('POST /connectors rejects unknown connectorId with 404', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({
        connectorId: 'made-up',
        catalogVersion: '1.0.0',
        instanceLabel: 'primary',
        vaultPath: 'tenants/x/connectors/y',
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_connector');
    expect(tenantConnectors.install).not.toHaveBeenCalled();
  });

  it('POST /connectors rejects missing fields with 400', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({ connectorId: 'github-issues' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(tenantConnectors.install).not.toHaveBeenCalled();
  });

  it('POST /connectors surfaces DuplicateConnectorInstanceError as 409', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors } = makeApp(TENANT);
    tenantConnectors.install.mockRejectedValueOnce(
      new DuplicateConnectorInstanceError('github-issues', 'primary'),
    );
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({
        connectorId: 'github-issues',
        catalogVersion: '1.0.0',
        instanceLabel: 'primary',
        vaultPath: 'tenants/x/connectors/y',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('duplicate_connector_instance');
    expect(res.body.connectorId).toBe('github-issues');
  });

  it('POST /connectors surfaces CredentialNotResolvableError as 422', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors } = makeApp(TENANT);
    tenantConnectors.install.mockRejectedValueOnce(
      new CredentialNotResolvableError('tenants/x/connectors/y'),
    );
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({
        connectorId: 'github-issues',
        catalogVersion: '1.0.0',
        instanceLabel: 'primary',
        vaultPath: 'tenants/x/connectors/y',
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('credential_not_resolvable');
    expect(res.body.vaultPath).toBe('tenants/x/connectors/y');
  });

  // ── Tenant cross-check ─────────────────────────────────────────────────
  it('returns 403 on every endpoint when URL tenant ≠ JWT tenant', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors, catalog } = makeApp(OTHER);
    const listRes = await supertest(app).get(`/tenants/${TENANT}/connectors`);
    const recRes  = await supertest(app).get(`/tenants/${TENANT}/connectors/recommendations?templateSlug=x`);
    const postRes = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({ connectorId: 'github-issues', catalogVersion: '1', instanceLabel: 'a', vaultPath: 'b' });
    expect(listRes.status).toBe(403);
    expect(recRes.status).toBe(403);
    expect(postRes.status).toBe(403);
    expect(tenantConnectors.listForTenant).not.toHaveBeenCalled();
    expect(tenantConnectors.install).not.toHaveBeenCalled();
    expect(catalog.recommendForDomain).not.toHaveBeenCalled();
  });

  // ── Custom connectors ──────────────────────────────────────────────────

  it('POST /connectors/custom registers a manifest as the JWT principal', async () => {
    const supertest = (await import('supertest')).default;
    const { app, customConnectors } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors/custom`)
      .send({
        connectorId: 'custom.acme-tracker', displayName: 'Acme Tracker',
        category: 'custom', description: 'Internal tracker', catalogVersion: '1.0.0',
        credentialSchema: { type: 'object' },
      });
    expect(res.status).toBe(201);
    expect(res.body.connector.connectorId).toBe('custom.acme-tracker');
    expect(customConnectors.register).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, createdBy: 'cccccccc-3333-4333-c333-cccccccccccc' }),
    );
  });

  it('GET /connectors/custom lists; GET /custom/:id details; DELETE disables', async () => {
    const supertest = (await import('supertest')).default;
    const { app, customConnectors } = makeApp(TENANT);
    expect((await supertest(app).get(`/tenants/${TENANT}/connectors/custom`)).body.count).toBe(1);
    expect((await supertest(app).get(`/tenants/${TENANT}/connectors/custom/custom.acme-tracker`)).status).toBe(200);
    expect((await supertest(app).delete(`/tenants/${TENANT}/connectors/custom/custom.acme-tracker`)).status).toBe(204);

    customConnectors.get.mockResolvedValueOnce(null);
    expect((await supertest(app).get(`/tenants/${TENANT}/connectors/custom/custom.nope`)).status).toBe(404);
    customConnectors.disable.mockResolvedValueOnce(false);
    expect((await supertest(app).delete(`/tenants/${TENANT}/connectors/custom/custom.nope`)).status).toBe(404);
  });

  it('POST / (install) accepts a REGISTERED custom id the catalog does not know', async () => {
    const supertest = (await import('supertest')).default;
    const { app, customConnectors, tenantConnectors } = makeApp(TENANT);
    customConnectors.installable.mockResolvedValueOnce(true);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({
        connectorId: 'custom.acme-tracker', catalogVersion: '1.0.0',
        instanceLabel: 'primary', vaultPath: 'tenants/x/connectors/acme',
      });
    expect(res.status).toBe(201);
    expect(tenantConnectors.install).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'custom.acme-tracker' }),
    );
  });

  it('POST / (install) still 404s an unregistered/disabled custom id — installable() is the gate', async () => {
    const supertest = (await import('supertest')).default;
    const { app, tenantConnectors } = makeApp(TENANT); // installable defaults false
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/connectors`)
      .send({
        connectorId: 'custom.not-registered', catalogVersion: '1.0.0',
        instanceLabel: 'primary', vaultPath: 'tenants/x/connectors/z',
      });
    expect(res.status).toBe(404);
    expect(tenantConnectors.install).not.toHaveBeenCalled();
  });

  it('custom endpoints answer 503 fail-closed when the service is not wired', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT, true, false);
    expect((await supertest(app).post(`/tenants/${TENANT}/connectors/custom`).send({})).status).toBe(503);
    expect((await supertest(app).get(`/tenants/${TENANT}/connectors/custom`)).status).toBe(503);
    expect((await supertest(app).delete(`/tenants/${TENANT}/connectors/custom/x`)).status).toBe(503);
  });
});
