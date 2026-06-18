/**
 * F.4.0: tenant-param cross-check + URL-vs-JWT 403 behaviour for
 * actionsExtended.routes mounted under /tenants/:tenantId/actions.
 *
 * Asserts:
 *   1. Matching JWT + URL tenantId → 200 (handler called with URL value).
 *   2. JWT tenantId ≠ URL tenantId → 403 `tenant_mismatch` (handler NOT called).
 *   3. Handler reads tenantId from the URL param (the source of truth).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createActionsExtendedRouter } from '../actionsExtended.routes.js';

function stubAuth(jwtTenantId: string, userId = 'u-1') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = req as unknown as Record<string, unknown>;
    r['tenantId'] = jwtTenantId;
    r['userId']   = userId;
    r['scopes']   = [];
    next();
  };
}

interface FakeQuotaSvc {
  usage: jest.Mock;
  preflight: jest.Mock;
}
function makeQuotaSvc(): FakeQuotaSvc {
  return {
    usage: jest.fn().mockResolvedValue([]),
    preflight: jest.fn().mockResolvedValue({ ok: true }),
  };
}

interface FakeMpas {
  listGrants: jest.Mock;
  createGrant: jest.Mock;
  revokeGrant: jest.Mock;
  getQuorumStatus: jest.Mock;
  castVote: jest.Mock;
  createDelegation: jest.Mock;
}
function makeMpas(): FakeMpas {
  return {
    listGrants: jest.fn().mockResolvedValue([]),
    createGrant: jest.fn(),
    revokeGrant: jest.fn(),
    getQuorumStatus: jest.fn(),
    castVote: jest.fn(),
    createDelegation: jest.fn(),
  };
}

function makeApp(jwtTenantId: string) {
  const quotaService    = makeQuotaSvc();
  const multiPartyApproval = makeMpas();
  const app = express();
  app.use(express.json());
  app.use(stubAuth(jwtTenantId));
  app.use('/tenants/:tenantId/actions', createActionsExtendedRouter({
    quotaService:    quotaService as unknown as Parameters<typeof createActionsExtendedRouter>[0]['quotaService'],
    multiPartyApproval: multiPartyApproval as unknown as Parameters<typeof createActionsExtendedRouter>[0]['multiPartyApproval'],
  }));
  return { app, quotaService, multiPartyApproval };
}

describe('F.4.0: /tenants/:tenantId/actions tenant-param cross-check', () => {
  const URL_TENANT = '11111111-1111-4111-a111-111111111111';
  const OTHER_TENANT = '22222222-2222-4222-b222-222222222222';

  it('passes through when JWT.tenantId == URL.tenantId', async () => {
    const supertest = (await import('supertest')).default;
    const { app, quotaService } = makeApp(URL_TENANT);
    const res = await supertest(app).get(`/tenants/${URL_TENANT}/actions/grants`);
    expect(res.status).toBe(200);
  });

  it('returns 403 tenant_mismatch when JWT.tenantId ≠ URL.tenantId', async () => {
    const supertest = (await import('supertest')).default;
    const { app, multiPartyApproval } = makeApp(OTHER_TENANT);
    const res = await supertest(app).get(`/tenants/${URL_TENANT}/actions/grants`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_mismatch');
    // Handler must NOT be reached.
    expect(multiPartyApproval.listGrants).not.toHaveBeenCalled();
  });

  it('handler sees the URL tenantId, not the JWT claim, on match', async () => {
    const supertest = (await import('supertest')).default;
    const { app, multiPartyApproval } = makeApp(URL_TENANT);
    await supertest(app).get(`/tenants/${URL_TENANT}/actions/grants`);
    expect(multiPartyApproval.listGrants).toHaveBeenCalledWith(URL_TENANT);
  });

  it('returns 403 for the quotas/usage endpoint on mismatch', async () => {
    const supertest = (await import('supertest')).default;
    const { app, quotaService } = makeApp(OTHER_TENANT);
    const res = await supertest(app).get(`/tenants/${URL_TENANT}/actions/quotas/usage`);
    expect(res.status).toBe(403);
    expect(quotaService.usage).not.toHaveBeenCalled();
  });

  it('returns 403 for grants POST on mismatch (mutating method)', async () => {
    const supertest = (await import('supertest')).default;
    const { app, multiPartyApproval } = makeApp(OTHER_TENANT);
    const res = await supertest(app)
      .post(`/tenants/${URL_TENANT}/actions/grants`)
      .send({
        actionClass: 'financial.payment',
        grantedByUserIds: ['11111111-1111-4111-a111-aaaaaaaaaaaa'],
        grantedToKind: 'user',
        durationSeconds: 600,
        maxUses: 1,
      });
    expect(res.status).toBe(403);
    expect(multiPartyApproval.createGrant).not.toHaveBeenCalled();
  });
});
