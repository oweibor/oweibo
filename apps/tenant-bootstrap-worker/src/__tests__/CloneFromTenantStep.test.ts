/**
 * T.9 — CloneFromTenantStep tests.
 *
 * Mocks the pg pool. Verifies:
 *   - skips when feature flag is off
 *   - skips when no lineage row (regular tenant)
 *   - skips when cloner not wired
 *   - threads RLS scope (`SET LOCAL app.tenant_id`)
 *   - returns 'ok' when at least one scope succeeds
 *   - returns 'failed' only when every requested scope fails
 *   - swallows cloner thrown errors as 'failed' (does not bubble)
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  CloneFromTenantStep,
  type ITenantCloner,
  type CloneScopeResult,
} from '../steps/CloneFromTenantStep.js';
import type { IBootstrapStepContext } from '../steps/IBootstrapStep.js';

const silentLogger = {
  info: () => undefined, warn: () => undefined, error: () => undefined,
};

const TENANT = '11111111-1111-1111-1111-111111111111';
const PARENT = '99999999-9999-9999-9999-999999999999';

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
      command: '', oid: 0, fields: [],
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

function ctx(overrides: Partial<IBootstrapStepContext> = {}, pool?: Pool): IBootstrapStepContext {
  return {
    tenantId: TENANT,
    templateSlug: 'default',
    pool: pool ?? ({} as Pool),
    logger: silentLogger,
    features: overrides.features ?? {},
    seedCohort: 'seeded',
    ...overrides,
  } as IBootstrapStepContext;
}

describe('CloneFromTenantStep', () => {
  it('skips when feature flag is off (no lineage lookup)', async () => {
    const { pool, calls } = makePool([]);
    const step = new CloneFromTenantStep();
    const status = await step.execute(ctx({}, pool));
    expect(status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('skips when no lineage row exists (regular tenant)', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_lineage', rows: [] },
    ]);
    const cloner: ITenantCloner = { clone: jest.fn() };
    const step = new CloneFromTenantStep({ cloner });
    const status = await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    expect(status).toBe('skipped');
    expect(cloner.clone).not.toHaveBeenCalled();
  });

  it('skips when lineage row exists but cloner is not wired', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_lineage',
        rows: [{ parent_tenant_id: PARENT, cloned_scopes: ['memories', 'projects'] }] },
    ]);
    const step = new CloneFromTenantStep();
    const status = await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    expect(status).toBe('skipped');
  });

  it('threads RLS scope via SET LOCAL app.tenant_id before reading lineage', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.tenant_lineage', rows: [] },
    ]);
    const step = new CloneFromTenantStep({ cloner: { clone: jest.fn() } });
    await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    const setLocal = calls.find((c) => c.sql.includes('SET LOCAL app.tenant_id'));
    expect(setLocal).toBeDefined();
    expect(setLocal?.params).toEqual([TENANT]);
  });

  it('invokes cloner with parent + child + scopes and returns "ok" on partial success', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_lineage',
        rows: [{ parent_tenant_id: PARENT, cloned_scopes: ['memories', 'projects'] }] },
    ]);
    const results: readonly CloneScopeResult[] = [
      { scope: 'memories', status: 'ok', copied: 5 },
      { scope: 'projects', status: 'failed', error: 'boom' },
    ];
    const cloner: ITenantCloner = { clone: jest.fn().mockResolvedValue({ results }) };
    const step = new CloneFromTenantStep({ cloner });
    const status = await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    expect(status).toBe('ok'); // at least one scope succeeded
    expect(cloner.clone).toHaveBeenCalledWith({
      parentTenantId: PARENT,
      childTenantId: TENANT,
      scopes: ['memories', 'projects'],
    });
  });

  it('returns "failed" only when every requested scope failed', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_lineage',
        rows: [{ parent_tenant_id: PARENT, cloned_scopes: ['memories', 'projects'] }] },
    ]);
    const cloner: ITenantCloner = {
      clone: jest.fn().mockResolvedValue({
        results: [
          { scope: 'memories', status: 'failed', error: 'boom1' },
          { scope: 'projects', status: 'failed', error: 'boom2' },
        ] as readonly CloneScopeResult[],
      }),
    };
    const step = new CloneFromTenantStep({ cloner });
    const status = await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    expect(status).toBe('failed');
  });

  it('treats a thrown cloner as failed (does not bubble)', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_lineage',
        rows: [{ parent_tenant_id: PARENT, cloned_scopes: ['memories'] }] },
    ]);
    const cloner: ITenantCloner = {
      clone: jest.fn().mockRejectedValue(new Error('cloner exploded')),
    };
    const step = new CloneFromTenantStep({ cloner });
    const status = await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    expect(status).toBe('failed');
  });

  it('filters out unrecognised scopes from the lineage row before invoking cloner', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_lineage',
        rows: [{ parent_tenant_id: PARENT, cloned_scopes: ['memories', 'totally-fake'] }] },
    ]);
    const cloner: ITenantCloner = {
      clone: jest.fn().mockResolvedValue({ results: [{ scope: 'memories', status: 'ok', copied: 1 }] }),
    };
    const step = new CloneFromTenantStep({ cloner });
    await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    expect(cloner.clone).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['memories'] }),
    );
  });

  it('skips when every cloned_scope is unrecognised', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.tenant_lineage',
        rows: [{ parent_tenant_id: PARENT, cloned_scopes: ['totally-fake', 'also-fake'] }] },
    ]);
    const cloner: ITenantCloner = { clone: jest.fn() };
    const step = new CloneFromTenantStep({ cloner });
    const status = await step.execute(ctx({ features: { 'tenant_lineage.enabled': true } }, pool));
    expect(status).toBe('skipped');
    expect(cloner.clone).not.toHaveBeenCalled();
  });
});
