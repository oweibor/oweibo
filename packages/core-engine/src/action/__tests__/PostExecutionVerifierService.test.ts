/**
 * S.5.b — PostExecutionVerifierService tests.
 *
 * Covers:
 *   - InMemoryVerifierRegistry: register/duplicate/matching/resolve
 *   - runImmediate: feature-flag off → noop
 *   - runImmediate: verifier match → records row + queues deferred
 *   - runImmediate: severity 3 → auto-rollback hook invoked
 *   - runImmediate: verifier throws → logged sev 2, not propagated
 *   - runDueDeferred: claims via FOR UPDATE SKIP LOCKED, records outcome,
 *     marks done; unknown verifier → failed_terminal
 *   - runDueDeferred: verifier returns null → retry with backoff;
 *     attempts > 5 → failed_terminal
 *   - supersedeForProposal: marks pending rows superseded
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type {
  ActionContext,
  IPostExecutionVerifier,
  VerificationOutcome,
} from '@oweibo/core-contracts';
import {
  PostExecutionVerifierService,
  InMemoryVerifierRegistry,
} from '../PostExecutionVerifierService.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PROPOSAL = '22222222-2222-2222-2222-222222222222';

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

function makeCtx(actionClass: string): ActionContext {
  return {
    tenantId: TENANT,
    userId: '33333333-3333-3333-3333-333333333333',
    actionClass: actionClass as ActionContext['actionClass'],
    actionId: 'a-1',
    summary: 's',
    payload: {},
    calibrationSnapshot: {
      tenantId: TENANT,
      accountAgeDays: 30,
      actionClassScores: {},
      snapshotAt: new Date().toISOString(),
      sourceSig: 'sig',
    },
  };
}

function makeVerifier(spec: Partial<IPostExecutionVerifier> & { name: string; appliesTo?: () => boolean }): IPostExecutionVerifier {
  return {
    name: spec.name,
    appliesTo: spec.appliesTo ?? (() => true),
    ...(spec.immediate ? { immediate: spec.immediate } : {}),
    ...(spec.deferred ? { deferred: spec.deferred } : {}),
    ...(spec.deferredCheckAfterSeconds !== undefined ? { deferredCheckAfterSeconds: spec.deferredCheckAfterSeconds } : {}),
  } as IPostExecutionVerifier;
}

// ── Registry ────────────────────────────────────────────────────────────

describe('InMemoryVerifierRegistry', () => {
  it('register + resolve + names', () => {
    const reg = new InMemoryVerifierRegistry();
    const a = makeVerifier({ name: 'a' });
    const b = makeVerifier({ name: 'b' });
    reg.register(a);
    reg.register(b);
    expect(reg.resolve('a')).toBe(a);
    expect(reg.names()).toEqual(['a', 'b']);
  });

  it('refuses duplicates', () => {
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({ name: 'x' }));
    expect(() => reg.register(makeVerifier({ name: 'x' }))).toThrow(/duplicate/);
  });

  it('matching filters by appliesTo', () => {
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({ name: 'deploy', appliesTo: (c: string) => c === 'deploy.prod' }));
    reg.register(makeVerifier({ name: 'all',    appliesTo: () => true }));
    expect(reg.matching('deploy.prod').map((v) => v.name).sort()).toEqual(['all', 'deploy']);
    expect(reg.matching('read.local').map((v) => v.name)).toEqual(['all']);
  });
});

// ── runImmediate ────────────────────────────────────────────────────────

describe('PostExecutionVerifierService.runImmediate', () => {
  it('feature flag off → empty', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    const svc = new PostExecutionVerifierService(pool, reg, { isEnabled: () => false });
    const r = await svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: { ok: true },
    });
    expect(r.worstSeverity).toBe(0);
    expect(r.perVerifier).toEqual([]);
  });

  it('no matching verifiers → empty', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({ name: 'narrow', appliesTo: (c: string) => c === 'deploy.prod' }));
    const svc = new PostExecutionVerifierService(pool, reg, { isEnabled: () => true });
    const r = await svc.runImmediate({
      ctx: makeCtx('read.local'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(r.perVerifier).toEqual([]);
  });

  it('records immediate outcome and queues deferred when both declared', async () => {
    const { pool, calls } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'health',
      appliesTo: () => true,
      immediate: async (): Promise<VerificationOutcome> => ({
        severity: 0, expected: 'healthy', observed: 'healthy',
      }),
      deferred: async (): Promise<VerificationOutcome> => ({ severity: 0, expected: 'ok', observed: 'ok' }),
      deferredCheckAfterSeconds: 300,
    }));
    const svc = new PostExecutionVerifierService(pool, reg, { isEnabled: () => true });
    const r = await svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: { version: 'v1.2.3' },
    });
    expect(r.worstSeverity).toBe(0);
    expect(r.perVerifier).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.post_execution_verifications'))).toBe(true);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.deferred_verifications'))).toBe(true);
  });

  it('verifier throws → recorded as sev 2 (notify) not propagated', async () => {
    const { pool, calls } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'broken',
      immediate: async (): Promise<VerificationOutcome> => { throw new Error('boom'); },
    }));
    const svc = new PostExecutionVerifierService(pool, reg, { isEnabled: () => true, log: () => undefined });
    const r = await svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(r.worstSeverity).toBe(2);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.post_execution_verifications'))).toBe(true);
  });

  it('sev 3 → autoRollback hook invoked', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 3, expected: 'A', observed: 'B' }),
    }));
    const autoRollback = jest.fn().mockResolvedValue({ ok: true });
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      autoRollback,
      log: () => undefined,
    });
    const r = await svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(r.worstSeverity).toBe(3);
    expect(autoRollback).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, proposalId: PROPOSAL,
    }));
  });

  it('sev 3 without autoRollback wired → no throw', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 3, expected: 'A', observed: 'B' }),
    }));
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      log: () => undefined,
    });
    await expect(svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: null,
    })).resolves.toBeDefined();
  });

  // ── F.2.4: autoHitlHandoff hook ─────────────────────────────────────────

  it('F.2.4: sev 3 on a trigger-class action fires autoHitlHandoff', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 3, expected: 'A', observed: 'B' }),
    }));
    const autoHitlHandoff = jest.fn().mockResolvedValue({ ok: true });
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      autoHitlHandoff,
      log: () => undefined,
    });
    await svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(autoHitlHandoff).toHaveBeenCalledTimes(1);
    expect(autoHitlHandoff).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      proposalId: PROPOSAL,
      actionClass: 'deploy.prod',
      triggeredBy: 'auto_drift_detection',
    }));
  });

  it('F.2.4: sev 3 on a non-trigger class does NOT fire autoHitlHandoff', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 3, expected: 'A', observed: 'B' }),
    }));
    const autoHitlHandoff = jest.fn().mockResolvedValue({ ok: true });
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      autoHitlHandoff,
      log: () => undefined,
    });
    await svc.runImmediate({
      ctx: makeCtx('write.tenant_db.users'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(autoHitlHandoff).not.toHaveBeenCalled();
  });

  it('F.2.4: sev <3 never fires autoHitlHandoff', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 2, expected: 'A', observed: 'B' }),
    }));
    const autoHitlHandoff = jest.fn().mockResolvedValue({ ok: true });
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      autoHitlHandoff,
      log: () => undefined,
    });
    await svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(autoHitlHandoff).not.toHaveBeenCalled();
  });

  it('F.2.4: autoHitlHandoff hook throwing does NOT break runImmediate', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 3, expected: 'A', observed: 'B' }),
    }));
    const autoHitlHandoff = jest.fn().mockRejectedValue(new Error('vault down'));
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      autoHitlHandoff,
      log: () => undefined,
    });
    await expect(svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: null,
    })).resolves.toBeDefined();
  });

  it('F.2.4: autoHitlTriggerClasses overrides the default allowlist', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 3, expected: 'A', observed: 'B' }),
    }));
    const autoHitlHandoff = jest.fn().mockResolvedValue({ ok: true });
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      autoHitlHandoff,
      autoHitlTriggerClasses: ['only.this.class'],
      log: () => undefined,
    });
    await svc.runImmediate({
      ctx: makeCtx('deploy.prod'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(autoHitlHandoff).not.toHaveBeenCalled();

    await svc.runImmediate({
      ctx: makeCtx('only.this.class'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(autoHitlHandoff).toHaveBeenCalledTimes(1);
  });

  it('F.2.4: financial.* prefix matches financial.payment', async () => {
    const { pool } = makePool([]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'drift',
      immediate: async (): Promise<VerificationOutcome> => ({ severity: 3, expected: 'A', observed: 'B' }),
    }));
    const autoHitlHandoff = jest.fn().mockResolvedValue({ ok: true });
    const svc = new PostExecutionVerifierService(pool, reg, {
      isEnabled: () => true,
      autoHitlHandoff,
      log: () => undefined,
    });
    await svc.runImmediate({
      ctx: makeCtx('financial.payment'), proposalId: PROPOSAL, adapterOutcome: null,
    });
    expect(autoHitlHandoff).toHaveBeenCalledTimes(1);
  });
});

// ── runDueDeferred ──────────────────────────────────────────────────────

describe('PostExecutionVerifierService.runDueDeferred', () => {
  it('flag off → 0 rows', async () => {
    const { pool } = makePool([]);
    const svc = new PostExecutionVerifierService(pool, new InMemoryVerifierRegistry(),
      { isEnabled: () => false });
    expect(await svc.runDueDeferred()).toBe(0);
  });

  it('no due rows → 0', async () => {
    const { pool } = makePool([]);
    const svc = new PostExecutionVerifierService(pool, new InMemoryVerifierRegistry(),
      { isEnabled: () => true });
    expect(await svc.runDueDeferred()).toBe(0);
  });

  it('unknown verifier → failed_terminal', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.deferred_verifications',
        rows: [{
          id: 'd-1', tenant_id: TENANT, proposal_id: PROPOSAL,
          verifier_name: 'gone', verifier_config: {}, expected: {}, attempts: 1,
        }],
      },
    ]);
    const svc = new PostExecutionVerifierService(pool, new InMemoryVerifierRegistry(),
      { isEnabled: () => true });
    expect(await svc.runDueDeferred()).toBe(1);
    // markDone() uses `SET state = $2` with $2 = 'failed_terminal'.
    const update = calls.find((c) =>
      c.sql.includes('SET state = $2')
      && c.params[1] === 'failed_terminal',
    );
    expect(update).toBeDefined();
  });

  it('verifier returns outcome → records + marks done', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.deferred_verifications',
        rows: [{
          id: 'd-2', tenant_id: TENANT, proposal_id: PROPOSAL,
          verifier_name: 'ok-verifier', verifier_config: {}, expected: { x: 1 }, attempts: 1,
        }],
      },
    ]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'ok-verifier',
      deferred: async (): Promise<VerificationOutcome> => ({ severity: 0, expected: { x: 1 }, observed: { x: 1 } }),
    }));
    const svc = new PostExecutionVerifierService(pool, reg, { isEnabled: () => true });
    expect(await svc.runDueDeferred()).toBe(1);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.post_execution_verifications'))).toBe(true);
    expect(calls.some((c) => c.sql.includes("SET state = $2") && c.params[1] === 'done')).toBe(true);
  });

  it('verifier throws → reschedule with backoff', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.deferred_verifications',
        rows: [{
          id: 'd-3', tenant_id: TENANT, proposal_id: PROPOSAL,
          verifier_name: 'flaky', verifier_config: {}, expected: {}, attempts: 2,
        }],
      },
    ]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'flaky',
      deferred: async (): Promise<VerificationOutcome> => { throw new Error('timeout'); },
    }));
    const svc = new PostExecutionVerifierService(pool, reg,
      { isEnabled: () => true, now: () => new Date('2026-05-24T10:00:00Z') });
    await svc.runDueDeferred();
    // scheduleRetryOrFail() uses literal `SET state = 'pending'` (vs the
    // claim query's `SET state = 'running'`).
    const sched = calls.find((c) => c.sql.includes("SET state = 'pending'"));
    expect(sched).toBeDefined();
    // attempts=2 → backoff[1] = 5*60 = 300s after now
    const nextAt = sched!.params[1] as Date;
    expect(nextAt.getTime()).toBe(new Date('2026-05-24T10:05:00Z').getTime());
  });

  it('attempts exhausted → failed_terminal', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.deferred_verifications',
        rows: [{
          id: 'd-9', tenant_id: TENANT, proposal_id: PROPOSAL,
          verifier_name: 'flaky', verifier_config: {}, expected: {}, attempts: 5,
        }],
      },
    ]);
    const reg = new InMemoryVerifierRegistry();
    reg.register(makeVerifier({
      name: 'flaky',
      deferred: async (): Promise<VerificationOutcome> => { throw new Error('timeout'); },
    }));
    const svc = new PostExecutionVerifierService(pool, reg, { isEnabled: () => true });
    await svc.runDueDeferred();
    const upd = calls.find((c) =>
      c.sql.includes('SET state = $2') && c.params[1] === 'failed_terminal',
    );
    expect(upd).toBeDefined();
  });
});

// ── supersedeForProposal ─────────────────────────────────────────────────

describe('PostExecutionVerifierService.supersedeForProposal', () => {
  it('marks pending rows superseded', async () => {
    const { pool, calls } = makePool([
      { match: "SET state = 'superseded'", rows: [{}, {}, {}] }, // simulate 3 rows updated
    ]);
    const svc = new PostExecutionVerifierService(pool, new InMemoryVerifierRegistry());
    const n = await svc.supersedeForProposal(TENANT, PROPOSAL);
    expect(n).toBe(3);
    expect(calls.some((c) =>
      c.sql.includes("UPDATE oweibo.deferred_verifications")
      && c.sql.includes("'superseded'"),
    )).toBe(true);
  });
});
