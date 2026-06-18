/**
 * Unit tests for DryRunRegistry — verify list/get/pin/unpin against a mock pool.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { DryRunRegistry } from '../DryRunRegistry.js';
import type { GatePrincipal } from '@oweibo/core-contracts';

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
    query: jest.fn(),
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

const PRINCIPAL: GatePrincipal = {
  sub: '22222222-2222-2222-2222-222222222222',
  scopes: [],
  ctx: { tenantId: '11111111-1111-1111-1111-111111111111' },
};

describe('DryRunRegistry.list', () => {
  it('returns mapped proposal summaries with default state filter', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT id, tenant_id',
        rows: [{
          id: 'p1', tenant_id: 't1', user_id: 'u1',
          action_class: 'write.external_api.nonprod', action_id: 'a1',
          mode: 'dry_run', summary: 'do thing',
          rollback_kind: 'trivial', state: 'pending',
          created_at: '2026-05-22T00:00:00Z', expires_at: '2026-05-29T00:00:00Z',
          decided_at: null, decided_by: null, decision_reason: null,
        }],
      },
    ]);
    const reg = new DryRunRegistry(pool);
    const out = await reg.list(PRINCIPAL);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('p1');
    expect(out[0]?.actionClass).toBe('write.external_api.nonprod');
    // Default filter is ['pending']
    const listSql = calls.find((c) => c.sql.includes('FROM oweibo.action_proposals'));
    expect(listSql).toBeDefined();
    expect(listSql?.params[0]).toEqual(['pending']);
  });

  it('honors custom state filter', async () => {
    const { pool, calls } = makePool([
      { match: 'SELECT id, tenant_id', rows: [] },
    ]);
    const reg = new DryRunRegistry(pool);
    await reg.list(PRINCIPAL, { state: ['rejected', 'executed_live'] });
    const listSql = calls.find((c) => c.sql.includes('FROM oweibo.action_proposals'));
    expect(listSql?.params[0]).toEqual(['rejected', 'executed_live']);
  });

  it('caps limit at 200', async () => {
    const { pool, calls } = makePool([
      { match: 'SELECT id, tenant_id', rows: [] },
    ]);
    const reg = new DryRunRegistry(pool);
    await reg.list(PRINCIPAL, { limit: 9999 });
    const listSql = calls.find((c) => c.sql.includes('FROM oweibo.action_proposals'));
    // Last param is limit
    expect(listSql?.params[listSql.params.length - 1]).toBe(200);
  });
});

describe('DryRunRegistry.get', () => {
  it('returns null when not found', async () => {
    const { pool } = makePool([
      { match: 'SELECT id, tenant_id, user_id, action_class', rows: [] },
    ]);
    const reg = new DryRunRegistry(pool);
    const out = await reg.get(PRINCIPAL, 'nope');
    expect(out).toBeNull();
  });

  it('returns full detail including payload', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT id, tenant_id, user_id, action_class',
        rows: [{
          id: 'p1', tenant_id: 't1', user_id: 'u1',
          action_class: 'write.external_api.nonprod', action_id: 'a1',
          mode: 'dry_run', summary: 'do thing',
          rollback_kind: null, rollback_detail: { foo: 1 }, payload: { bar: 2 },
          state: 'pending',
          created_at: '2026-05-22T00:00:00Z', expires_at: '2026-05-29T00:00:00Z',
          decided_at: null, decided_by: null, decision_reason: null,
        }],
      },
    ]);
    const reg = new DryRunRegistry(pool);
    const out = await reg.get(PRINCIPAL, 'p1');
    expect(out?.payload).toEqual({ bar: 2 });
    expect(out?.rollbackDetail).toEqual({ foo: 1 });
  });
});

describe('DryRunRegistry.listTrustMatrix', () => {
  it('returns matrix rows', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT action_class, current_mode',
        rows: [{
          action_class: 'comm.external_email',
          current_mode: 'dry_run',
          pinned_by: null,
          pinned_reason: null,
          observations: 3,
          successes: 2,
          rejections: 1,
          last_updated: '2026-05-22T00:00:00Z',
        }],
      },
    ]);
    const reg = new DryRunRegistry(pool);
    const out = await reg.listTrustMatrix(PRINCIPAL);
    expect(out).toHaveLength(1);
    expect(out[0]?.actionClass).toBe('comm.external_email');
    expect(out[0]?.observations).toBe(3);
  });
});

describe('DryRunRegistry.pin / unpin', () => {
  it('writes a pin with mode and reason', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.tenant_action_class_state', rows: [] },
    ]);
    const reg = new DryRunRegistry(pool);
    await reg.pin(PRINCIPAL, 'irreversible.public_publish', 'dry_run', 'never publish from prod');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_action_class_state'));
    expect(insert).toBeDefined();
    expect(insert?.params).toContain('dry_run');
    expect(insert?.params).toContain('never publish from prod');
  });

  it('clears the pin without deleting the row', async () => {
    const { pool, calls } = makePool([
      { match: 'UPDATE oweibo.tenant_action_class_state', rows: [] },
    ]);
    const reg = new DryRunRegistry(pool);
    await reg.unpin(PRINCIPAL, 'comm.external_email');
    const upd = calls.find((c) => c.sql.includes('SET pinned_by = NULL'));
    expect(upd).toBeDefined();
  });
});
