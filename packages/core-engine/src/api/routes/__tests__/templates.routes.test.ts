/**
 * F.4.7: templates routes integration tests.
 *
 * Covers:
 *   - GET / returns the active catalog.
 *   - GET /:slug returns the template detail.
 *   - GET /:slug returns 404 for unknown slug.
 *   - Tenant cross-check 403.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createTemplatesRouter } from '../templates.routes.js';

function stubAuth(jwtTenantId: string, userId = 'u-1') {
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

const TEMPLATE = {
  slug: 'fintech-core',
  displayName: 'Fintech Core',
  description: 'Banking + payments',
  industries: ['finance'],
  defaultFeatures: {},
  defaultQuotas: {},
  seedMemoryTags: [],
  seedSkillSet: 'default',
  goalTemplateSet: 'default',
  active: true,
};

function makeStubs() {
  const templates = {
    list: jest.fn().mockResolvedValue([TEMPLATE]),
    get:  jest.fn().mockImplementation(async (slug: string) =>
      slug === TEMPLATE.slug ? TEMPLATE : null),
    invalidate: jest.fn(),
  };
  return { templates };
}

function makeApp(jwtTenant: string) {
  const stubs = makeStubs();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenant));
  app.use('/tenants/:tenantId/templates', createTemplatesRouter({
    templates: stubs.templates as unknown as Parameters<typeof createTemplatesRouter>[0]['templates'],
  }));
  return { app, ...stubs };
}

describe('F.4.7: templates routes', () => {
  it('GET /templates returns the active catalog', async () => {
    const supertest = (await import('supertest')).default;
    const { app, templates } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/templates`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.count).toBe(1);
    expect(res.body.templates[0].slug).toBe('fintech-core');
    expect(templates.list).toHaveBeenCalled();
  });

  it('GET /templates/:slug returns the detail', async () => {
    const supertest = (await import('supertest')).default;
    const { app, templates } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/templates/fintech-core`);
    expect(res.status).toBe(200);
    expect(res.body.template.displayName).toBe('Fintech Core');
    expect(templates.get).toHaveBeenCalledWith('fintech-core');
  });

  it('GET /templates/:slug returns 404 for unknown slug', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp(TENANT);
    const res = await supertest(app).get(`/tenants/${TENANT}/templates/made-up`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('returns 403 on every endpoint when URL tenant ≠ JWT tenant', async () => {
    const supertest = (await import('supertest')).default;
    const { app, templates } = makeApp(OTHER);
    const list = await supertest(app).get(`/tenants/${TENANT}/templates`);
    const det  = await supertest(app).get(`/tenants/${TENANT}/templates/fintech-core`);
    expect(list.status).toBe(403);
    expect(det.status).toBe(403);
    expect(templates.list).not.toHaveBeenCalled();
    expect(templates.get).not.toHaveBeenCalled();
  });
});
