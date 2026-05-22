/**
 * T.5.a — CalibrationService tests.
 *
 * Covers:
 *   - global score formula edge cases (brand-new, partial, fully calibrated)
 *   - per-action-class score formula (zero observations → floor only)
 *   - signal gathering: account age clamp, completed task count, bootstrap
 *     ready state, action-class observations and success ratios
 *   - snapshot + sourceSig signing + verification
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  CalibrationService,
  globalScore,
  perClassScores,
  type CalibrationSignals,
} from '../CalibrationService.js';

// ── Mock pool ──────────────────────────────────────────────────────────────

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
    return Promise.resolve({
      rows: stub ? stub.rows : [],
      rowCount: stub ? stub.rows.length : 0,
      command: '',
      oid: 0,
      fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const FIXED_NOW = new Date('2026-05-22T12:00:00Z');

function baselineSignals(overrides: Partial<CalibrationSignals> = {}): CalibrationSignals {
  return {
    accountAgeDays: 0,
    organicMemoryCount: 0,
    slotsWithLearnedArms: 0,
    completedTaskCount: 0,
    bootstrapReady: false,
    actionClassObservations: {},
    actionClassSuccessRatios: {},
    ...overrides,
  };
}

// ── Formula tests ──────────────────────────────────────────────────────────

describe('globalScore', () => {
  it('returns 0 for a brand-new tenant', () => {
    expect(globalScore(baselineSignals())).toBe(0);
  });
  it('returns 1.0 when every signal is saturated', () => {
    const score = globalScore(baselineSignals({
      accountAgeDays: 60,
      organicMemoryCount: 200,
      slotsWithLearnedArms: 50,
      completedTaskCount: 100,
      bootstrapReady: true,
    }));
    expect(score).toBeCloseTo(1.0, 5);
  });
  it('weights add up to 1.0 (0.20+0.30+0.20+0.20+0.10)', () => {
    // Saturated each term independently then summed yields the weights.
    const score = globalScore(baselineSignals({
      accountAgeDays: 30,
      organicMemoryCount: 50,
      slotsWithLearnedArms: 8,
      completedTaskCount: 25,
      bootstrapReady: true,
    }));
    expect(score).toBeCloseTo(1.0, 5);
  });
  it('bootstrap-only contributes exactly 0.10', () => {
    expect(globalScore(baselineSignals({ bootstrapReady: true }))).toBeCloseTo(0.10, 5);
  });
});

describe('perClassScores', () => {
  it('zero-observation class scores no more than 0.20 (age + bootstrap floor)', () => {
    const out = perClassScores(baselineSignals({
      accountAgeDays: 30,
      bootstrapReady: true,
      actionClassObservations: { 'write.external_api.prod': 0 },
      actionClassSuccessRatios: { 'write.external_api.prod': 0 },
    }));
    expect(out['write.external_api.prod']).toBeCloseTo(0.20, 5);
  });
  it('zero-observation class with no age or bootstrap is 0', () => {
    const out = perClassScores(baselineSignals({
      actionClassObservations: { 'x': 0 },
      actionClassSuccessRatios: { 'x': 0 },
    }));
    expect(out['x']).toBe(0);
  });
  it('observations + perfect success → top of the class score', () => {
    const out = perClassScores(baselineSignals({
      accountAgeDays: 30,
      bootstrapReady: true,
      actionClassObservations: { 'a': 30 },     // saturates obs term
      actionClassSuccessRatios: { 'a': 1.0 },   // saturates ratio term
    }));
    // 0.40 + 0.40 + 0.10 + 0.10 = 1.00
    expect(out['a']).toBeCloseTo(1.0, 5);
  });
  it('mixed ratio reduces the ratio contribution proportionally', () => {
    const out = perClassScores(baselineSignals({
      actionClassObservations: { 'a': 20 },
      actionClassSuccessRatios: { 'a': 0.5 },
    }));
    // 0.40 + 0.20 + 0 + 0 = 0.60
    expect(out['a']).toBeCloseTo(0.60, 5);
  });
});

// ── compute() integration over mocked DB ──────────────────────────────────

describe('CalibrationService.compute', () => {
  it('handles a brand-new tenant: 0 observations, 0 tasks, bootstrap pending', async () => {
    const created = new Date('2026-05-22T11:30:00Z'); // 30 min before FIXED_NOW = 0 days
    const { pool } = makePool([
      { match: 'SELECT created_at FROM oweibo.tenants', rows: [{ created_at: created }] },
      { match: 'COUNT(DISTINCT bae.slot_id)', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tasks', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tenant_bootstrap WHERE', rows: [{ state: 'pending' }] },
      { match: 'FROM oweibo.tenant_action_class_state', rows: [] },
    ]);
    const svc = new CalibrationService(pool, { now: () => FIXED_NOW });
    const r = await svc.compute(TENANT_ID);
    expect(r.signals.accountAgeDays).toBe(0);
    expect(r.signals.bootstrapReady).toBe(false);
    expect(r.score).toBe(0);
    expect(r.actionClassScores).toEqual({});
    expect(r.summary).toMatch(/Brand new/i);
  });

  it('clamps account age at 30 days even for older tenants', async () => {
    const created = new Date('2026-01-01T00:00:00Z'); // ~141 days before FIXED_NOW
    const { pool } = makePool([
      { match: 'SELECT created_at FROM oweibo.tenants', rows: [{ created_at: created }] },
      { match: 'COUNT(DISTINCT bae.slot_id)', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tasks', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tenant_bootstrap WHERE', rows: [{ state: 'ready' }] },
      { match: 'FROM oweibo.tenant_action_class_state', rows: [] },
    ]);
    const svc = new CalibrationService(pool, { now: () => FIXED_NOW });
    const r = await svc.compute(TENANT_ID);
    expect(r.signals.accountAgeDays).toBe(30);
  });

  it('reads action-class observations + success ratio from tenant_action_class_state', async () => {
    const created = new Date('2026-05-15T00:00:00Z');
    const { pool } = makePool([
      { match: 'SELECT created_at FROM oweibo.tenants', rows: [{ created_at: created }] },
      { match: 'COUNT(DISTINCT bae.slot_id)', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tasks', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tenant_bootstrap WHERE', rows: [{ state: 'ready' }] },
      {
        match: 'FROM oweibo.tenant_action_class_state',
        rows: [
          { action_class: 'a', observations: 10, successes: 8 },
          { action_class: 'b', observations: 0, successes: 0 },
        ],
      },
    ]);
    const svc = new CalibrationService(pool, { now: () => FIXED_NOW });
    const r = await svc.compute(TENANT_ID);
    expect(r.signals.actionClassObservations).toEqual({ a: 10, b: 0 });
    expect(r.signals.actionClassSuccessRatios['a']).toBeCloseTo(0.8, 5);
    expect(r.signals.actionClassSuccessRatios['b']).toBe(0);
    // Per-class score for 'a' with 10 obs, 0.8 ratio, 7d age, bootstrap ready
    // = 0.40*(10/20) + 0.40*0.8 + 0.10*(7/30) + 0.10*1
    //  ~ 0.20 + 0.32 + 0.0233 + 0.10 = 0.6433
    expect(r.actionClassScores['a']).toBeCloseTo(0.20 + 0.32 + 0.10 * (7 / 30) + 0.10, 4);
  });

  it('uses injected organic memory counter', async () => {
    const created = new Date('2026-05-22T00:00:00Z');
    const { pool } = makePool([
      { match: 'SELECT created_at FROM oweibo.tenants', rows: [{ created_at: created }] },
      { match: 'COUNT(DISTINCT bae.slot_id)', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tasks', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tenant_bootstrap WHERE', rows: [{ state: 'pending' }] },
      { match: 'FROM oweibo.tenant_action_class_state', rows: [] },
    ]);
    const counter = jest.fn().mockResolvedValue(25);
    const svc = new CalibrationService(pool, {
      now: () => FIXED_NOW,
      countOrganicMemories: counter,
    });
    const r = await svc.compute(TENANT_ID);
    expect(counter).toHaveBeenCalledWith(TENANT_ID);
    expect(r.signals.organicMemoryCount).toBe(25);
    // memoryTerm = 0.30 * (25/50) = 0.15
    expect(r.score).toBeCloseTo(0.15, 5);
  });

  it('swallows counter errors and defaults to 0', async () => {
    const created = new Date('2026-05-22T00:00:00Z');
    const { pool } = makePool([
      { match: 'SELECT created_at FROM oweibo.tenants', rows: [{ created_at: created }] },
      { match: 'COUNT(DISTINCT bae.slot_id)', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tasks', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tenant_bootstrap WHERE', rows: [{ state: 'pending' }] },
      { match: 'FROM oweibo.tenant_action_class_state', rows: [] },
    ]);
    const svc = new CalibrationService(pool, {
      now: () => FIXED_NOW,
      countOrganicMemories: async () => { throw new Error('qdrant down'); },
    });
    const r = await svc.compute(TENANT_ID);
    expect(r.signals.organicMemoryCount).toBe(0);
  });

  it('returns 0 account age when tenant row missing', async () => {
    const { pool } = makePool([
      { match: 'SELECT created_at FROM oweibo.tenants', rows: [] },
      { match: 'COUNT(DISTINCT bae.slot_id)', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tasks', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tenant_bootstrap WHERE', rows: [] },
      { match: 'FROM oweibo.tenant_action_class_state', rows: [] },
    ]);
    const svc = new CalibrationService(pool, { now: () => FIXED_NOW });
    const r = await svc.compute(TENANT_ID);
    expect(r.signals.accountAgeDays).toBe(0);
    expect(r.signals.bootstrapReady).toBe(false);
  });
});

// ── snapshot() + sourceSig ─────────────────────────────────────────────────

describe('CalibrationService.snapshot + verify', () => {
  function basicPool(observations: number, successes: number) {
    const created = new Date('2026-05-15T00:00:00Z');
    return makePool([
      { match: 'SELECT created_at FROM oweibo.tenants', rows: [{ created_at: created }] },
      { match: 'COUNT(DISTINCT bae.slot_id)', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tasks', rows: [{ count: '0' }] },
      { match: 'FROM oweibo.tenant_bootstrap WHERE', rows: [{ state: 'ready' }] },
      {
        match: 'FROM oweibo.tenant_action_class_state',
        rows: [{ action_class: 'write.local.scratch', observations, successes }],
      },
    ]);
  }

  it('snapshot() returns the minimal fields ActionTrustLadder consumes', async () => {
    const { pool } = basicPool(5, 5);
    const svc = new CalibrationService(pool, { now: () => FIXED_NOW, sourceKey: 'test-key' });
    const snap = await svc.snapshot(TENANT_ID);
    expect(snap.tenantId).toBe(TENANT_ID);
    expect(snap.accountAgeDays).toBe(7);
    expect(snap.actionClassScores['write.local.scratch']).toBeGreaterThan(0);
    expect(snap.snapshotAt).toBe(FIXED_NOW.toISOString());
    expect(snap.sourceSig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('snapshot() roundtrips through verify()', async () => {
    const { pool } = basicPool(5, 5);
    const svc = new CalibrationService(pool, { now: () => FIXED_NOW, sourceKey: 'roundtrip-key' });
    const snap = await svc.snapshot(TENANT_ID);
    expect(svc.verify(snap)).toBe(true);
  });

  it('verify() rejects a snapshot whose tenantId was tampered', async () => {
    const { pool } = basicPool(5, 5);
    const svc = new CalibrationService(pool, { now: () => FIXED_NOW, sourceKey: 'tamper-key' });
    const snap = await svc.snapshot(TENANT_ID);
    const tampered = { ...snap, tenantId: 'other' };
    expect(svc.verify(tampered)).toBe(false);
  });

  it('verify() rejects a snapshot signed with a different key', async () => {
    const { pool } = basicPool(5, 5);
    const issuer = new CalibrationService(pool, { now: () => FIXED_NOW, sourceKey: 'a' });
    const snap = await issuer.snapshot(TENANT_ID);
    const { pool: pool2 } = basicPool(5, 5);
    const verifier = new CalibrationService(pool2, { now: () => FIXED_NOW, sourceKey: 'b' });
    expect(verifier.verify(snap)).toBe(false);
  });

  it('verify() rejects an empty sourceSig', async () => {
    const { pool } = makePool([]);
    const svc = new CalibrationService(pool, { sourceKey: 'k' });
    expect(svc.verify({
      tenantId: 't',
      accountAgeDays: 0,
      actionClassScores: {},
      snapshotAt: 'now',
      sourceSig: '',
    })).toBe(false);
  });
});
