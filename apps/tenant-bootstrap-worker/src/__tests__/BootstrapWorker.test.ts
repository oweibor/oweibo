/**
 * Unit tests for BootstrapWorker. Drives a mock Pool to verify:
 *   - no-op fast path on state=ready / state=disabled
 *   - pipeline runs every step, writes step rows, ends in 'ready' when all skip
 *   - a failing step blocks the pipeline, sets state='failed', records last_error
 *   - max-attempts dead-letters cleanly
 *   - already-ok/skipped steps are not re-executed
 *   - the orchestrator threads the features object through to step ctx
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { BootstrapWorker } from '../BootstrapWorker.js';
import type { IBootstrapStep, IBootstrapStepContext, StepStatus } from '../steps/IBootstrapStep.js';

// ── Mock pool ──────────────────────────────────────────────────────────────

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
} {
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
const silent = {
  info:  () => undefined,
  warn:  () => undefined,
  error: () => undefined,
};

function makeStep(name: string, status: StepStatus, opts?: { onExec?: (ctx: IBootstrapStepContext) => void }): IBootstrapStep {
  return {
    name,
    async execute(ctx) {
      opts?.onExec?.(ctx);
      return status;
    },
  };
}

const noFeatures = async (): Promise<Readonly<Record<string, unknown>>> => ({});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('BootstrapWorker.handleTenantCreated', () => {
  it('no-ops when state=ready', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT tenant_id, state, template_slug',
        rows: [{ tenant_id: TENANT_ID, state: 'ready', template_slug: 'default', attempts: 1 }],
      },
    ]);
    const worker = new BootstrapWorker(pool, noFeatures, { logger: silent, pipeline: [] });
    const result = await worker.handleTenantCreated(TENANT_ID);
    expect(result).toBe('noop');
    // No transition / step writes
    expect(calls.find((c) => c.sql.includes('UPDATE oweibo.tenant_bootstrap'))).toBeUndefined();
  });

  it('no-ops when state=disabled', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT tenant_id, state, template_slug',
        rows: [{ tenant_id: TENANT_ID, state: 'disabled', template_slug: 'default', attempts: 0 }],
      },
    ]);
    const worker = new BootstrapWorker(pool, noFeatures, { logger: silent, pipeline: [] });
    expect(await worker.handleTenantCreated(TENANT_ID)).toBe('noop');
  });

  it('warns and returns noop when no bootstrap row exists', async () => {
    const { pool } = makePool([
      { match: 'SELECT tenant_id, state, template_slug', rows: [] },
    ]);
    const worker = new BootstrapWorker(pool, noFeatures, { logger: silent, pipeline: [] });
    expect(await worker.handleTenantCreated(TENANT_ID)).toBe('noop');
  });

  it('runs all steps and ends ready when every step skips', async () => {
    const { pool, calls } = makePool([
      {
        match: 'SELECT tenant_id, state, template_slug',
        rows: [{ tenant_id: TENANT_ID, state: 'pending', template_slug: 'default', attempts: 0 }],
      },
      { match: 'SELECT attempts, status', rows: [] },
    ]);
    const pipeline = [
      makeStep('a', 'skipped'),
      makeStep('b', 'skipped'),
    ];
    const worker = new BootstrapWorker(pool, noFeatures, { logger: silent, pipeline });
    expect(await worker.handleTenantCreated(TENANT_ID)).toBe('ready');

    const stepInserts = calls.filter((c) =>
      c.sql.includes('INSERT INTO oweibo.tenant_bootstrap_steps'),
    );
    // Each step gets a 'running' insert then a 'skipped' update via ON CONFLICT.
    expect(stepInserts.length).toBe(4); // 2 steps × (running + skipped)

    const finalTransition = [...calls].reverse().find((c) =>
      c.sql.includes('UPDATE oweibo.tenant_bootstrap')
      && Array.isArray(c.params)
      && c.params[1] === 'ready',
    );
    expect(finalTransition).toBeDefined();
  });

  it('threads features through to step context', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT tenant_id, state, template_slug',
        rows: [{ tenant_id: TENANT_ID, state: 'pending', template_slug: 'starter', attempts: 0 }],
      },
      { match: 'SELECT attempts, status', rows: [] },
    ]);
    let seen: IBootstrapStepContext | undefined;
    const step = makeStep('a', 'ok', { onExec: (ctx) => { seen = ctx; } });
    const features = { 'tenant.bootstrap.demo.enabled': true } as const;
    const worker = new BootstrapWorker(pool, async () => features, { logger: silent, pipeline: [step] });
    await worker.handleTenantCreated(TENANT_ID);
    expect(seen?.tenantId).toBe(TENANT_ID);
    expect(seen?.templateSlug).toBe('starter');
    expect(seen?.features).toEqual(features);
  });

  it('skips already-ok step rows', async () => {
    let lookupCount = 0;
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      if (sql.includes('SELECT tenant_id, state, template_slug')) {
        return Promise.resolve({
          rows: [{ tenant_id: TENANT_ID, state: 'pending', template_slug: 'default', attempts: 0 }],
          rowCount: 1, command: '', oid: 0, fields: [],
        });
      }
      if (sql.includes('SELECT attempts, status')) {
        lookupCount += 1;
        if (lookupCount === 1) {
          return Promise.resolve({
            rows: [{ attempts: 1, status: 'ok' }],
            rowCount: 1, command: '', oid: 0, fields: [],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = {
      query: jest.fn().mockImplementation(queryFn),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool;

    let bExecuted = false;
    const pipeline = [
      makeStep('a', 'ok', { onExec: () => { throw new Error('a should not be re-run'); } }),
      makeStep('b', 'ok', { onExec: () => { bExecuted = true; } }),
    ];
    const worker = new BootstrapWorker(pool, noFeatures, { logger: silent, pipeline });
    await worker.handleTenantCreated(TENANT_ID);
    expect(bExecuted).toBe(true);
  });

  it('marks state=failed when a step returns failed beyond max attempts', async () => {
    let stepLookupCount = 0;
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      if (sql.includes('SELECT tenant_id, state, template_slug')) {
        return Promise.resolve({
          rows: [{ tenant_id: TENANT_ID, state: 'pending', template_slug: 'default', attempts: 0 }],
          rowCount: 1, command: '', oid: 0, fields: [],
        });
      }
      if (sql.includes('SELECT attempts, status')) {
        stepLookupCount += 1;
        // First call (pre-execution): no existing row.
        if (stepLookupCount === 1) {
          return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
        }
        // Second call (post-failure attempts check): already at max.
        return Promise.resolve({
          rows: [{ attempts: 3, status: 'failed' }],
          rowCount: 1, command: '', oid: 0, fields: [],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = {
      query: jest.fn().mockImplementation(queryFn),
      release: jest.fn(),
    } as unknown as PoolClient;
    const calls: string[] = [];
    (client.query as jest.Mock).mockImplementation((sql: string, params?: unknown[]) => {
      calls.push(sql);
      return queryFn(sql);
    });
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool;

    const pipeline = [makeStep('a', 'failed')];
    const worker = new BootstrapWorker(pool, noFeatures, {
      logger: silent,
      pipeline,
      maxAttemptsPerStep: 3,
    });
    expect(await worker.handleTenantCreated(TENANT_ID)).toBe('failed');
  });

  it('treats a step that throws as failed', async () => {
    const { pool } = makePool([
      {
        match: 'SELECT tenant_id, state, template_slug',
        rows: [{ tenant_id: TENANT_ID, state: 'pending', template_slug: 'default', attempts: 0 }],
      },
      { match: 'SELECT attempts, status', rows: [] },
    ]);
    const thrower: IBootstrapStep = {
      name: 'thrower',
      async execute() { throw new Error('boom'); },
    };
    const worker = new BootstrapWorker(pool, noFeatures, {
      logger: silent,
      pipeline: [thrower],
      maxAttemptsPerStep: 1,
    });
    expect(await worker.handleTenantCreated(TENANT_ID)).toBe('failed');
  });

  it('treats first failure as retryable when under max attempts', async () => {
    let stepLookupCount = 0;
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      if (sql.includes('SELECT tenant_id, state, template_slug')) {
        return Promise.resolve({
          rows: [{ tenant_id: TENANT_ID, state: 'pending', template_slug: 'default', attempts: 0 }],
          rowCount: 1, command: '', oid: 0, fields: [],
        });
      }
      if (sql.includes('SELECT attempts, status')) {
        stepLookupCount += 1;
        if (stepLookupCount === 1) {
          return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
        }
        return Promise.resolve({
          rows: [{ attempts: 1, status: 'failed' }],
          rowCount: 1, command: '', oid: 0, fields: [],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = {
      query: jest.fn().mockImplementation(queryFn),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool;

    const worker = new BootstrapWorker(pool, noFeatures, {
      logger: silent,
      pipeline: [makeStep('a', 'failed')],
      maxAttemptsPerStep: 3,
    });
    // Below max attempts, still terminal 'failed' for this run (will retry on next event)
    expect(await worker.handleTenantCreated(TENANT_ID)).toBe('failed');
  });
});
