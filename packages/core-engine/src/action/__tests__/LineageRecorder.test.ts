/**
 * S.0 — LineageRecorder tests.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { LineageRecorder } from '../LineageRecorder.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PLAN = '22222222-2222-2222-2222-222222222222';

interface QueryStub { match: string; rows: QueryResultRow[]; }

function makePool(stubs: QueryStub[], opts: { failOn?: string } = {}): {
  pool: Pool; calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    if (opts.failOn && sql.includes(opts.failOn)) {
      return Promise.reject(new Error('pg down'));
    }
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
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

const silent = () => undefined;

describe('LineageRecorder.recordOrThrow', () => {
  it('writes a lineage row with all fields and returns the new id', async () => {
    const { pool, calls } = makePool([
      { match: 'RETURNING id', rows: [{ id: 'node-xyz' }] },
    ]);
    const recorder = new LineageRecorder(pool, { log: silent });
    const id = await recorder.recordOrThrow({
      tenantId: TENANT,
      planId: PLAN,
      parentNodeId: null,
      kind: 'gate_decision',
      producer: { type: 'gate', id: 'plan-gate' },
      summary: 'plan-level approval granted',
      detail: { mode: 'require_approval_for_plan' },
    });
    expect(id).toBe('node-xyz');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.action_lineage'));
    expect(insert).toBeDefined();
    expect(insert?.params[0]).toBe(TENANT);
    expect(insert?.params[1]).toBe(PLAN);
    expect(insert?.params[2]).toBeNull();
    expect(insert?.params[3]).toBe('gate_decision');
    expect(insert?.params[4]).toBe('gate');
  });

  it('sets tenant scope via SET LOCAL app.tenant_id before insert', async () => {
    const { pool, calls } = makePool([
      { match: 'RETURNING id', rows: [{ id: 'n1' }] },
    ]);
    const recorder = new LineageRecorder(pool, { log: silent });
    await recorder.recordOrThrow({
      tenantId: TENANT, planId: PLAN, parentNodeId: null,
      kind: 'execution', producer: { type: 'agent', id: 'a1' },
      summary: 's', detail: {},
    });
    const setLocal = calls.find((c) => c.sql.includes('SET LOCAL app.tenant_id'));
    expect(setLocal).toBeDefined();
  });
});

describe('LineageRecorder.record (best-effort)', () => {
  it('swallows failures and returns empty string', async () => {
    const { pool } = makePool([], { failOn: 'INSERT INTO oweibo.action_lineage' });
    const recorder = new LineageRecorder(pool, { log: silent });
    const id = await recorder.record({
      tenantId: TENANT, planId: PLAN, parentNodeId: null,
      kind: 'execution', producer: { type: 'agent', id: 'a1' },
      summary: 's', detail: {},
    });
    expect(id).toBe('');
  });

  it('returns the node id on success', async () => {
    const { pool } = makePool([{ match: 'RETURNING id', rows: [{ id: 'ok' }] }]);
    const recorder = new LineageRecorder(pool, { log: silent });
    const id = await recorder.record({
      tenantId: TENANT, planId: PLAN, parentNodeId: null,
      kind: 'execution', producer: { type: 'agent', id: 'a1' },
      summary: 's', detail: {},
    });
    expect(id).toBe('ok');
  });
});

describe('LineageRecorder.readPlanLineage', () => {
  it('returns lineage nodes ordered by recorded_at', async () => {
    const t1 = new Date('2026-05-20T10:00:00Z');
    const t2 = new Date('2026-05-20T11:00:00Z');
    const { pool } = makePool([
      {
        match: 'FROM oweibo.action_lineage',
        rows: [
          { id: 'n1', plan_id: PLAN, parent_node_id: null, kind: 'gate_decision',
            producer_type: 'gate', producer_id: 'plan-gate', summary: 'gated',
            detail: { ok: true }, trace_id: null, recorded_at: t1 },
          { id: 'n2', plan_id: PLAN, parent_node_id: 'n1', kind: 'execution',
            producer_type: 'agent', producer_id: 'exec-agent', summary: 'executed',
            detail: {}, trace_id: 'trace-1', recorded_at: t2 },
        ],
      },
    ]);
    const recorder = new LineageRecorder(pool, { log: silent });
    const nodes = await recorder.readPlanLineage(TENANT, PLAN);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.nodeId).toBe('n1');
    expect(nodes[0]?.parentNodeId).toBeNull();
    expect(nodes[1]?.parentNodeId).toBe('n1');
    expect(nodes[1]?.traceId).toBe('trace-1');
  });
});
