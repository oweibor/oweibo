/**
 * F.4.5: domains routes integration tests with stubbed services.
 *
 * Covers all 8 endpoints + the tenant-param cross-check.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createDomainsRouter } from '../domains.routes.js';

function stubAuth(jwtTenantId: string, userId = 'cccccccc-3333-4333-c333-cccccccccccc') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as unknown as Record<string, unknown>;
    r['tenantId'] = jwtTenantId;
    r['userId']   = userId;
    r['scopes']   = [];
    next();
  };
}

const TENANT    = '11111111-1111-4111-a111-111111111111';
const OTHER     = '22222222-2222-4222-b222-222222222222';
const QUEUE_ID  = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

function makeStubs() {
  const registry = {
    list: jest.fn().mockReturnValue([
      { slug: 'fintech', displayName: 'Fintech', category: 'regulated', maturity: 'general_availability' },
      { slug: 'healthcare', displayName: 'Healthcare', category: 'regulated', maturity: 'beta' },
    ]),
  };
  const bindings = [{
    tenantId: TENANT, domainSlug: 'fintech', role: 'primary',
    weight: 1.0, rawWeight: 1.0,
    boundBy: { type: 'admin', id: 'u-1' },
    confidence: null,
    boundAt: '2026-05-29T00:00:00.000Z',
  }];
  const bindingService = {
    listBindings: jest.fn().mockResolvedValue(bindings),
    replaceBindings: jest.fn().mockResolvedValue(bindings),
  };
  const bindingLookup = {
    invalidate: jest.fn(),
    invalidateAll: jest.fn(),
  };
  const smeReview = {
    listPendingForTenant: jest.fn().mockResolvedValue([
      { id: QUEUE_ID, domainSlug: 'fintech', tenantId: TENANT, artifactKind: 'memory',
        artifactRef: {}, anonymizedPayload: {}, state: 'pending',
        requiredReviews: 2, sampledAt: '2026-05-29T00:00:00.000Z', closedAt: null },
    ]),
    submitReview: jest.fn().mockResolvedValue('rev-1'),
  };
  const depthMetrics = {
    listLatestSnapshots: jest.fn().mockResolvedValue([
      { domainSlug: 'fintech', snapshotAt: '2026-05-29T00:00:00.000Z',
        compositeScore: 72, recommendedTier: 'general_availability',
        ontologyCoverage: {}, evalCoverage: {}, complianceCoverage: {},
        connectorCoverage: {}, smeCoverage: {} },
    ]),
  };
  const evaluations = {
    listForTenant: jest.fn().mockResolvedValue({
      rows: [{
        id: 'e1', proposalId: null, ruleId: 'FIN-001', domainSlug: 'fintech',
        packVersion: 'v1', enforcementPhase: 'action_time', verdict: 'warn',
        details: {}, bypassPrincipal: null, bypassReason: null,
        evaluatedAt: '2026-05-29T00:00:00.000Z',
      }],
      nextCursor: null,
    }),
  };
  return { registry, bindingService, bindingLookup, smeReview, depthMetrics, evaluations };
}

function makeApp(jwtTenant: string) {
  const stubs = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/domains', createDomainsRouter({
    registry:       stubs.registry       as unknown as Parameters<typeof createDomainsRouter>[0]['registry'],
    bindingService: stubs.bindingService as unknown as Parameters<typeof createDomainsRouter>[0]['bindingService'],
    bindingLookup:  stubs.bindingLookup  as unknown as Parameters<typeof createDomainsRouter>[0]['bindingLookup'],
    smeReview:      stubs.smeReview      as unknown as Parameters<typeof createDomainsRouter>[0]['smeReview'],
    depthMetrics:   stubs.depthMetrics   as unknown as Parameters<typeof createDomainsRouter>[0]['depthMetrics'],
    evaluations:    stubs.evaluations    as unknown as Parameters<typeof createDomainsRouter>[0]['evaluations'],
  }));
  return { app, ...stubs };
}

describe('F.4.5: domains routes', () => {
  it('GET /domains/registry returns the canonical taxonomy', async () => {
    const supertest = (await import('supertest')).default;
    const { app, registry } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/domains/registry`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.count).toBe(2);
    expect(registry.list).toHaveBeenCalled();
  });

  it('GET /domains/bindings returns the tenant bindings', async () => {
    const supertest = (await import('supertest')).default;
    const { app, bindingService } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/domains/bindings`);
    expect(res.status).toBe(200);
    expect(res.body.bindings).toHaveLength(1);
    expect(bindingService.listBindings).toHaveBeenCalledWith(TENANT);
  });

  it('PUT /domains/bindings replaces bindings + invalidates lookup cache', async () => {
    const supertest = (await import('supertest')).default;
    const { app, bindingService, bindingLookup } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/domains/bindings`)
      .send({
        bindings: [{
          domainSlug: 'fintech', role: 'primary', rawWeight: 1.0,
          boundBy: { type: 'admin', id: 'u-1' },
        }],
      });
    expect(res.status).toBe(200);
    expect(bindingService.replaceBindings).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
    }));
    expect(bindingLookup.invalidate).toHaveBeenCalledWith(TENANT);
  });

  it('PUT /domains/bindings rejects invalid binding shape with 400', async () => {
    const supertest = (await import('supertest')).default;
    const { app, bindingService } = makeApp(TENANT);
    const res = await supertest(app)
      .put(`/tenants/${TENANT}/domains/bindings`)
      .send({ bindings: [{ domainSlug: 'x', role: 'wrong', rawWeight: 2 }] });
    expect(res.status).toBe(400);
    expect(bindingService.replaceBindings).not.toHaveBeenCalled();
  });

  it('GET /domains/sme-review lists pending tenant reviews', async () => {
    const supertest = (await import('supertest')).default;
    const { app, smeReview } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/domains/sme-review`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(smeReview.listPendingForTenant).toHaveBeenCalledWith(TENANT, {});
  });

  it('POST /domains/sme-review/:id/vote submits the review', async () => {
    const supertest = (await import('supertest')).default;
    const { app, smeReview } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/domains/sme-review/${QUEUE_ID}/vote`)
      .send({ overallVerdict: 'accept', comment: 'lgtm' });
    expect(res.status).toBe(201);
    expect(res.body.reviewId).toBe('rev-1');
    expect(smeReview.submitReview).toHaveBeenCalledWith(expect.objectContaining({
      queueItemId: QUEUE_ID,
      reviewerId: 'cccccccc-3333-4333-c333-cccccccccccc',
      overallVerdict: 'accept',
      comment: 'lgtm',
    }));
  });

  it('POST /domains/sme-review/:id/vote rejects invalid verdict with 400', async () => {
    const supertest = (await import('supertest')).default;
    const { app, smeReview } = makeApp(TENANT);
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/domains/sme-review/${QUEUE_ID}/vote`)
      .send({ overallVerdict: 'maybe' });
    expect(res.status).toBe(400);
    expect(smeReview.submitReview).not.toHaveBeenCalled();
  });

  it('POST /domains/sme-review/:id/vote surfaces UNIQUE conflict as 409', async () => {
    const supertest = (await import('supertest')).default;
    const { app, smeReview } = makeApp(TENANT);
    smeReview.submitReview.mockRejectedValueOnce(new Error('duplicate key violates UNIQUE'));
    const res = await supertest(app)
      .post(`/tenants/${TENANT}/domains/sme-review/${QUEUE_ID}/vote`)
      .send({ overallVerdict: 'accept' });
    expect(res.status).toBe(409);
  });

  it('GET /domains/depth returns latest snapshot per domain', async () => {
    const supertest = (await import('supertest')).default;
    const { app, depthMetrics } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/domains/depth`);
    expect(res.status).toBe(200);
    expect(res.body.snapshots).toHaveLength(1);
    expect(res.body.snapshots[0].compositeScore).toBe(72);
    expect(depthMetrics.listLatestSnapshots).toHaveBeenCalled();
  });

  it('GET /domains/compliance/evaluations returns paged rows', async () => {
    const supertest = (await import('supertest')).default;
    const { app, evaluations } = makeApp(TENANT);
    const res = await supertest(app).get(
      `/tenants/${TENANT}/domains/compliance/evaluations?verdict=warn&limit=50`,
    );
    expect(res.status).toBe(200);
    expect(res.body.evaluations).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
    expect(evaluations.listForTenant).toHaveBeenCalledWith(TENANT, {
      verdicts: ['warn'], limit: 50,
    });
  });

  it('POST /domains/compliance/refresh invalidates the binding cache', async () => {
    const supertest = (await import('supertest')).default;
    const { app, bindingLookup } = makeApp(TENANT);
    const res = await supertest(app).post(`/tenants/${TENANT}/domains/compliance/refresh`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.invalidated).toBe(TENANT);
    expect(bindingLookup.invalidate).toHaveBeenCalledWith(TENANT);
  });

  // ── Tenant cross-check ─────────────────────────────────────────────────
  it('returns 403 on every endpoint when URL tenant ≠ JWT tenant', async () => {
    const supertest = (await import('supertest')).default;
    const { app, bindingService, smeReview, depthMetrics, evaluations, bindingLookup } = makeApp(OTHER);
    const paths: Array<[string, () => Promise<unknown>]> = [
      ['registry',     () => supertest(app).get(`/tenants/${TENANT}/domains/registry`)],
      ['bindings GET', () => supertest(app).get(`/tenants/${TENANT}/domains/bindings`)],
      ['bindings PUT', () => supertest(app).put(`/tenants/${TENANT}/domains/bindings`).send({ bindings: [] })],
      ['sme-review',   () => supertest(app).get(`/tenants/${TENANT}/domains/sme-review`)],
      ['depth',        () => supertest(app).get(`/tenants/${TENANT}/domains/depth`)],
      ['evaluations',  () => supertest(app).get(`/tenants/${TENANT}/domains/compliance/evaluations`)],
      ['refresh',      () => supertest(app).post(`/tenants/${TENANT}/domains/compliance/refresh`)],
    ];
    for (const [name, run] of paths) {
      const r = await run() as { status: number };
      expect(r.status).toBe(403);
      void name;
    }
    expect(bindingService.listBindings).not.toHaveBeenCalled();
    expect(bindingService.replaceBindings).not.toHaveBeenCalled();
    expect(smeReview.listPendingForTenant).not.toHaveBeenCalled();
    expect(depthMetrics.listLatestSnapshots).not.toHaveBeenCalled();
    expect(evaluations.listForTenant).not.toHaveBeenCalled();
    expect(bindingLookup.invalidate).not.toHaveBeenCalled();
  });
});
