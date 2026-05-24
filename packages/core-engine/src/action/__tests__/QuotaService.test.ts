/**
 * S.6 — QuotaService + BudgetEstimator tests.
 *
 * Covers:
 *   - Pure helpers: windowStartFor, nextResetAt, effectiveLimit
 *   - preflight: feature-flag off, no policies, allow under limit,
 *     deny at limit, soft_warn doesn't block, cold-start ramp,
 *     usd_cost_* with estimator contribution
 *   - record: increments three windows per kind, includes usd + blast
 *     when supplied
 *   - BudgetEstimator: tenant_history when ≥ 30 obs, platform_prior
 *     when contributor_count ≥ 5, falls through to platform_default
 *   - platformBudgetDefault: longest-prefix match, fallback
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { ActionClass, QuotaPolicy } from '@oweibo/core-contracts';
import {
  QuotaService,
  effectiveLimit,
  windowStartFor,
  nextResetAt,
} from '../QuotaService.js';
import { BudgetEstimator } from '../BudgetEstimator.js';
import { platformBudgetDefault } from '../budget-defaults.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface QueryStub { match: string; rows: QueryResultRow[]; }

function makePool(stubs: QueryStub[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs
      .filter((s) => sql.includes(s.match))
      .sort((a, b) => b.match.length - a.match.length)[0];
    return Promise.resolve({
      rows: stub ? stub.rows : [],
      rowCount: stub ? stub.rows.length : 0,
      command: '', oid: 0, fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('windowStartFor', () => {
  it('day → midnight UTC of same day', () => {
    expect(windowStartFor('day', new Date('2026-05-24T15:30:00Z'))).toBe('2026-05-24');
  });
  it('month → 1st of month', () => {
    expect(windowStartFor('month', new Date('2026-05-24T15:30:00Z'))).toBe('2026-05-01');
  });
  it('year → Jan 1', () => {
    expect(windowStartFor('year', new Date('2026-05-24T15:30:00Z'))).toBe('2026-01-01');
  });
});

describe('nextResetAt', () => {
  it('day → next day midnight UTC', () => {
    expect(nextResetAt('day', new Date('2026-05-24T15:30:00Z'))).toBe('2026-05-25T00:00:00.000Z');
  });
  it('month → next 1st', () => {
    expect(nextResetAt('month', new Date('2026-05-24T15:30:00Z'))).toBe('2026-06-01T00:00:00.000Z');
  });
  it('year → next Jan 1', () => {
    expect(nextResetAt('year', new Date('2026-05-24T15:30:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('effectiveLimit', () => {
  const base: QuotaPolicy = {
    tenantId: TENANT,
    quotaKind: 'action_count_per_class',
    scope: 'read.local',
    window: 'day',
    limitValue: 10_000,
    coldStartDurationDays: 30,
    enforcementMode: 'hard',
  };
  it('returns steady limit when no cold_start_limit', () => {
    expect(effectiveLimit(base, 5)).toBe(10_000);
  });
  it('returns cold_start_limit when age < duration', () => {
    expect(effectiveLimit({ ...base, coldStartLimit: 500 }, 5)).toBe(500);
  });
  it('returns steady_limit when age >= duration', () => {
    expect(effectiveLimit({ ...base, coldStartLimit: 500 }, 30)).toBe(10_000);
  });
});

// ── platformBudgetDefault ────────────────────────────────────────────────

describe('platformBudgetDefault', () => {
  it('longest-prefix match wins', () => {
    expect(platformBudgetDefault('deploy.prod' as ActionClass)).toBe(200);
    expect(platformBudgetDefault('deploy.nonprod' as ActionClass)).toBe(25);
  });
  it('zero for read.local', () => {
    expect(platformBudgetDefault('read.local')).toBe(0);
  });
  it('falls back to 10 cents for unknown classes', () => {
    expect(platformBudgetDefault('something.weird' as ActionClass)).toBe(10);
  });
});

// ── QuotaService.preflight ──────────────────────────────────────────────

describe('QuotaService.preflight', () => {
  const now = () => new Date('2026-05-24T15:30:00Z');

  it('feature flag off → allow', async () => {
    const { pool, calls } = makePool([]);
    const svc = new QuotaService(pool, { isEnabled: () => false, now });
    const r = await svc.preflight({ tenantId: TENANT, actionClass: 'read.local' });
    expect(r).toEqual({ kind: 'allow' });
    expect(calls.length).toBe(0);
  });

  it('no matching policies → allow', async () => {
    const { pool } = makePool([]);
    const svc = new QuotaService(pool, { isEnabled: () => true, now });
    const r = await svc.preflight({ tenantId: TENANT, actionClass: 'read.local' });
    expect(r).toEqual({ kind: 'allow' });
  });

  it('under limit → allow', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.quota_policies',
        rows: [{
          tenant_id: TENANT, quota_kind: 'total_actions', scope: '*', window: 'day',
          limit_value: '100', cold_start_limit: null, cold_start_duration_days: 30,
          enforcement_mode: 'hard',
        }],
      },
      {
        match: 'FROM oweibo.quota_consumption',
        rows: [{ consumed: '50' }],
      },
    ]);
    const svc = new QuotaService(pool, { isEnabled: () => true, now, accountAgeResolver: async () => 365 });
    const r = await svc.preflight({ tenantId: TENANT, actionClass: 'read.local' });
    expect(r.kind).toBe('allow');
  });

  it('at limit → deny when hard', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.quota_policies',
        rows: [{
          tenant_id: TENANT, quota_kind: 'total_actions', scope: '*', window: 'day',
          limit_value: '100', cold_start_limit: null, cold_start_duration_days: 30,
          enforcement_mode: 'hard',
        }],
      },
      {
        match: 'FROM oweibo.quota_consumption',
        rows: [{ consumed: '100' }],
      },
    ]);
    const svc = new QuotaService(pool, { isEnabled: () => true, now, accountAgeResolver: async () => 365 });
    const r = await svc.preflight({ tenantId: TENANT, actionClass: 'read.local' });
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') {
      expect(r.limit).toBe(100);
      expect(r.consumed).toBe(100);
      expect(r.resetAt).toBe('2026-05-25T00:00:00.000Z');
    }
  });

  it('over limit + soft enforcement → soft_warn (continue)', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.quota_policies',
        rows: [{
          tenant_id: TENANT, quota_kind: 'total_actions', scope: '*', window: 'day',
          limit_value: '100', cold_start_limit: null, cold_start_duration_days: 30,
          enforcement_mode: 'soft',
        }],
      },
      {
        match: 'FROM oweibo.quota_consumption',
        rows: [{ consumed: '150' }],
      },
    ]);
    const svc = new QuotaService(pool, { isEnabled: () => true, now, accountAgeResolver: async () => 365 });
    const r = await svc.preflight({ tenantId: TENANT, actionClass: 'read.local' });
    expect(r.kind).toBe('soft_warn');
  });

  it('cold-start cap applies when age < duration', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.quota_policies',
        rows: [{
          tenant_id: TENANT, quota_kind: 'total_actions', scope: '*', window: 'day',
          limit_value: '10000', cold_start_limit: '50', cold_start_duration_days: 30,
          enforcement_mode: 'hard',
        }],
      },
      {
        match: 'FROM oweibo.quota_consumption',
        rows: [{ consumed: '49' }], // 49 + 1 (delta) = 50 = limit; 51 would exceed
      },
    ]);
    const svc = new QuotaService(pool, { isEnabled: () => true, now, accountAgeResolver: async () => 5 });
    const r = await svc.preflight({ tenantId: TENANT, actionClass: 'read.local' });
    // 49 + 1 = 50; 50 > 50 is false → allow
    expect(r.kind).toBe('allow');
  });

  it('cold-start cap denies at limit', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.quota_policies',
        rows: [{
          tenant_id: TENANT, quota_kind: 'total_actions', scope: '*', window: 'day',
          limit_value: '10000', cold_start_limit: '50', cold_start_duration_days: 30,
          enforcement_mode: 'hard',
        }],
      },
      {
        match: 'FROM oweibo.quota_consumption',
        rows: [{ consumed: '50' }], // 50 + 1 = 51 > 50 → deny
      },
    ]);
    const svc = new QuotaService(pool, { isEnabled: () => true, now, accountAgeResolver: async () => 5 });
    const r = await svc.preflight({ tenantId: TENANT, actionClass: 'read.local' });
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.limit).toBe(50); // cold-start cap, not steady
  });

  it('usd_cost_total uses estimated cost as delta', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.quota_policies',
        rows: [{
          tenant_id: TENANT, quota_kind: 'usd_cost_total', scope: '*', window: 'day',
          limit_value: '5000', cold_start_limit: null, cold_start_duration_days: 30,
          enforcement_mode: 'hard',
        }],
      },
      {
        match: 'FROM oweibo.quota_consumption',
        rows: [{ consumed: '4500' }],
      },
    ]);
    const svc = new QuotaService(pool, { isEnabled: () => true, now, accountAgeResolver: async () => 365 });
    // 4500 + 600 = 5100 > 5000 → deny
    const r = await svc.preflight({
      tenantId: TENANT, actionClass: 'deploy.prod', estimatedCostUsdCents: 600,
    });
    expect(r.kind).toBe('deny');
  });
});

// ── QuotaService.record ─────────────────────────────────────────────────

describe('QuotaService.record', () => {
  it('feature flag off → no insert', async () => {
    const { pool, calls } = makePool([]);
    const svc = new QuotaService(pool, { isEnabled: () => false });
    await svc.record({ tenantId: TENANT, actionClass: 'read.local' });
    expect(calls.length).toBe(0);
  });

  it('writes 3 windows × 2 kinds for action+total without cost', async () => {
    const { pool, calls } = makePool([]);
    const svc = new QuotaService(pool, { isEnabled: () => true });
    await svc.record({ tenantId: TENANT, actionClass: 'read.local' });
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO oweibo.quota_consumption'));
    expect(inserts.length).toBe(6); // 2 kinds × 3 windows
  });

  it('also writes usd_cost kinds when actualCostUsdCents > 0', async () => {
    const { pool, calls } = makePool([]);
    const svc = new QuotaService(pool, { isEnabled: () => true });
    await svc.record({ tenantId: TENANT, actionClass: 'deploy.prod', actualCostUsdCents: 250 });
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO oweibo.quota_consumption'));
    expect(inserts.length).toBe(12); // 4 kinds × 3 windows
  });

  it('writes blast_radius_user_count when supplied', async () => {
    const { pool, calls } = makePool([]);
    const svc = new QuotaService(pool, { isEnabled: () => true });
    await svc.record({ tenantId: TENANT, actionClass: 'comm.external_email', blastRadiusUsers: 50 });
    const blastInserts = calls.filter((c) =>
      c.sql.includes('INSERT INTO oweibo.quota_consumption')
      && c.params[1] === 'blast_radius_user_count',
    );
    expect(blastInserts.length).toBe(3);
  });
});

// ── BudgetEstimator ─────────────────────────────────────────────────────

describe('BudgetEstimator', () => {
  it('falls through to platform_default when no signal', async () => {
    const { pool } = makePool([]);
    const est = new BudgetEstimator(pool);
    const e = await est.estimate({ tenantId: TENANT, actionClass: 'deploy.prod' });
    expect(e.source).toBe('platform_default');
    expect(e.costUsdCents).toBe(200);
    expect(e.confidence).toBe('low');
  });

  it('uses tenant history when ≥30 obs', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.post_execution_verifications',
        rows: [{ p: '125.7', n: 50 }],
      },
    ]);
    const est = new BudgetEstimator(pool);
    const e = await est.estimate({ tenantId: TENANT, actionClass: 'deploy.prod' });
    expect(e.source).toBe('tenant_history');
    expect(e.costUsdCents).toBe(125);
    expect(e.confidence).toBe('high');
  });

  it('skips tenant history when n < 30', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.post_execution_verifications',
        rows: [{ p: '125', n: 10 }],
      },
      {
        match: 'FROM oweibo.platform_action_cost_priors',
        rows: [{ p50_cents: 80, p95_cents: 150, contributor_count: 12, home_region: '*' }],
      },
    ]);
    const est = new BudgetEstimator(pool);
    const e = await est.estimate({ tenantId: TENANT, actionClass: 'deploy.prod' });
    expect(e.source).toBe('platform_prior');
    expect(e.costUsdCents).toBe(150); // p95 (conservative)
    expect(e.confidence).toBe('medium');
  });

  it('platform_prior uses p50 when aggressive', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.platform_action_cost_priors',
        rows: [{ p50_cents: 80, p95_cents: 150, contributor_count: 12, home_region: '*' }],
      },
    ]);
    const est = new BudgetEstimator(pool, { aggressiveForTenant: async () => true });
    const e = await est.estimate({ tenantId: TENANT, actionClass: 'deploy.prod' });
    expect(e.costUsdCents).toBe(80);
  });

  it('skips platform_prior when contributor_count < 5', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.platform_action_cost_priors',
        rows: [{ p50_cents: 80, p95_cents: 150, contributor_count: 3, home_region: '*' }],
      },
    ]);
    const est = new BudgetEstimator(pool);
    const e = await est.estimate({ tenantId: TENANT, actionClass: 'deploy.prod' });
    expect(e.source).toBe('platform_default');
    expect(e.costUsdCents).toBe(200);
  });

  it('caches subsequent lookups for 60s', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.platform_action_cost_priors',
        rows: [{ p50_cents: 80, p95_cents: 150, contributor_count: 10, home_region: '*' }],
      },
    ]);
    const est = new BudgetEstimator(pool, { now: () => new Date('2026-05-24T10:00:00Z') });
    await est.estimate({ tenantId: TENANT, actionClass: 'deploy.prod' });
    const callsBefore = calls.length;
    await est.estimate({ tenantId: TENANT, actionClass: 'deploy.prod' });
    expect(calls.length).toBe(callsBefore); // cache hit
  });
});
