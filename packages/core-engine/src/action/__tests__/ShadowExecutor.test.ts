/**
 * Unit tests for ShadowExecutor — verify observation accounting matches the
 * plan's T.−1 outcome table.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ShadowExecutor } from '../ShadowExecutor.js';
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

function stubPending(): QueryStub {
  return {
    match: 'SELECT tenant_id, action_class, state',
    rows: [{ tenant_id: 'aaaa', action_class: 'write.external_api.nonprod', state: 'pending' }],
  };
}

describe('ShadowExecutor.recordOutcome', () => {
  it('success + parity → observations+1, successes+1', async () => {
    const { pool, calls } = makePool([
      stubPending(),
      { match: 'UPDATE oweibo.action_proposals', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_action_class_state', rows: [] },
    ]);
    const exec = new ShadowExecutor(pool);
    await exec.recordOutcome(PRINCIPAL, {
      proposalId: 'p1', success: true, parity: 'parity',
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_action_class_state'));
    expect(ins).toBeDefined();
    // params order: tenant_id, action_class, successDelta, rejectionDelta
    expect(ins?.params[2]).toBe(1); // successDelta
    expect(ins?.params[3]).toBe(0); // rejectionDelta
  });

  it('success + drift → observations+1, rejections+1', async () => {
    const { pool, calls } = makePool([
      stubPending(),
      { match: 'UPDATE oweibo.action_proposals', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_action_class_state', rows: [] },
    ]);
    const exec = new ShadowExecutor(pool);
    await exec.recordOutcome(PRINCIPAL, {
      proposalId: 'p1', success: true, parity: 'drift',
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_action_class_state'));
    expect(ins?.params[2]).toBe(0);
    expect(ins?.params[3]).toBe(1);
  });

  it('failure → observations+1, rejections+1', async () => {
    const { pool, calls } = makePool([
      stubPending(),
      { match: 'UPDATE oweibo.action_proposals', rows: [] },
      { match: 'INSERT INTO oweibo.tenant_action_class_state', rows: [] },
    ]);
    const exec = new ShadowExecutor(pool);
    await exec.recordOutcome(PRINCIPAL, {
      proposalId: 'p1', success: false, parity: 'parity',
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_action_class_state'));
    expect(ins?.params[2]).toBe(0);
    expect(ins?.params[3]).toBe(1);
  });

  it('parity unknown → no observation recorded', async () => {
    const { pool, calls } = makePool([
      stubPending(),
      { match: 'UPDATE oweibo.action_proposals', rows: [] },
    ]);
    const exec = new ShadowExecutor(pool);
    await exec.recordOutcome(PRINCIPAL, {
      proposalId: 'p1', success: true, parity: 'unknown',
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO oweibo.tenant_action_class_state'));
    expect(ins).toBeUndefined();
  });

  it('throws when proposal missing', async () => {
    const { pool } = makePool([
      { match: 'SELECT tenant_id, action_class, state', rows: [] },
    ]);
    const exec = new ShadowExecutor(pool);
    await expect(
      exec.recordOutcome(PRINCIPAL, { proposalId: 'nope', success: true, parity: 'parity' }),
    ).rejects.toThrow(/no proposal/);
  });

  it('throws when proposal already decided', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT tenant_id, action_class, state',
        rows: [{ tenant_id: 'aaaa', action_class: 'x', state: 'executed_shadow' }],
      },
    ]);
    const exec = new ShadowExecutor(pool);
    await expect(
      exec.recordOutcome(PRINCIPAL, { proposalId: 'p1', success: true, parity: 'parity' }),
    ).rejects.toThrow(/already executed_shadow/);
  });
});
