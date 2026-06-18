/**
 * F.4.6: calibration route integration tests with a stubbed
 * CalibrationService.
 *
 * Covers:
 *   - Happy path returns badge-compatible response shape.
 *   - meetsAutonomousThreshold flag flips at 0.6.
 *   - gateEnabled flag flows through.
 *   - Tenant cross-check returns 403.
 *   - Service throw surfaces as 500.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { createCalibrationRouter } from '../calibration.routes.js';

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

function makeReadiness(score: number) {
  return {
    tenantId: TENANT,
    score,
    summary: `score=${score}`,
    actionClassScores: { 'financial.payment': score },
    signals: {
      accountAgeDays: 14,
      organicMemoryCount: 100,
      slotsWithLearnedArms: 3,
      completedTaskCount: 25,
      bootstrapReady: true,
      actionClassObservations: { 'financial.payment': 5 },
      actionClassSuccessRatios: { 'financial.payment': 0.9 },
    },
    snapshotAt: '2026-05-29T00:00:00.000Z',
    sourceSig: 'deadbeef',
  };
}

function makeApp(opts: { jwtTenant: string; score?: number; gateEnabled?: boolean; throws?: boolean }) {
  const score = opts.score ?? 0.72;
  const calibration = {
    compute: jest.fn().mockImplementation(async () => {
      if (opts.throws) throw new Error('db down');
      return makeReadiness(score);
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(stubAuth(opts.jwtTenant));
  app.use('/tenants/:tenantId/calibration', createCalibrationRouter({
    calibration: calibration as unknown as Parameters<typeof createCalibrationRouter>[0]['calibration'],
    gateEnabled: () => opts.gateEnabled ?? false,
  }));
  return { app, calibration };
}

describe('F.4.6: calibration route', () => {
  it('GET /calibration returns badge-compatible response', async () => {
    const supertest = (await import('supertest')).default;
    const { app, calibration } = makeApp({ jwtTenant: TENANT });
    const res = await supertest(app).get(`/tenants/${TENANT}/calibration`);
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TENANT);
    expect(res.body.score).toBeCloseTo(0.72);
    expect(res.body.threshold).toBe(0.6);
    expect(res.body.summary).toContain('score=');
    expect(res.body.signals).toMatchObject({
      accountAgeDays: 14,
      bootstrapReady: true,
    });
    // The badge-facing signal set must be number|boolean only — no
    // nested objects leaking through.
    for (const v of Object.values(res.body.signals)) {
      expect(['number', 'boolean']).toContain(typeof v);
    }
    expect(calibration.compute).toHaveBeenCalledWith(TENANT);
  });

  it('meetsAutonomousThreshold = true when score >= 0.6', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp({ jwtTenant: TENANT, score: 0.6 });
    const res = await supertest(app).get(`/tenants/${TENANT}/calibration`);
    expect(res.body.meetsAutonomousThreshold).toBe(true);
  });

  it('meetsAutonomousThreshold = false when score < 0.6', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp({ jwtTenant: TENANT, score: 0.59 });
    const res = await supertest(app).get(`/tenants/${TENANT}/calibration`);
    expect(res.body.meetsAutonomousThreshold).toBe(false);
  });

  it('gateEnabled flag flows through from override', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp({ jwtTenant: TENANT, gateEnabled: true });
    const res = await supertest(app).get(`/tenants/${TENANT}/calibration`);
    expect(res.body.gateEnabled).toBe(true);
  });

  it('returns 403 tenant_mismatch when URL ≠ JWT', async () => {
    const supertest = (await import('supertest')).default;
    const { app, calibration } = makeApp({ jwtTenant: OTHER });
    const res = await supertest(app).get(`/tenants/${TENANT}/calibration`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_mismatch');
    expect(calibration.compute).not.toHaveBeenCalled();
  });

  it('surfaces a service throw as 500 internal_error', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp({ jwtTenant: TENANT, throws: true });
    const res = await supertest(app).get(`/tenants/${TENANT}/calibration`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_error');
  });

  it('exposes actionClassScores + snapshotAt + sourceSig for downstream consumers', async () => {
    const supertest = (await import('supertest')).default;
    const { app } = makeApp({ jwtTenant: TENANT });
    const res = await supertest(app).get(`/tenants/${TENANT}/calibration`);
    expect(res.body.actionClassScores).toEqual({ 'financial.payment': 0.72 });
    expect(res.body.snapshotAt).toBe('2026-05-29T00:00:00.000Z');
    expect(res.body.sourceSig).toBe('deadbeef');
  });
});
