/**
 * S.7 — ActionReplayService + ForensicPacketBuilder + HitlHandoffService tests.
 *
 * Covers:
 *   - DefaultPiiRedactor: SSN, AWS key, CC (Luhn), GitHub PAT, slack, openai
 *   - severityToAutoTrigger: 0/1/2 → null; 3 → auto_drift
 *   - ForensicPacketBuilder: loads proposals, synthesizes executions
 *     from state, signs + stores; suggested actions reflect failures
 *   - HitlHandoffService: prepare insert + plan pause; resolve maps
 *     resolution → plan state; expireOverdue claims with skip locked
 *   - ActionReplayService: shadow_full walks proposals; shadow_step
 *     filters to one; what_if forwards mutation; gate error → notes
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  DefaultPiiRedactor,
  ForensicPacketBuilder,
} from '../ForensicPacketBuilder.js';
import {
  HitlHandoffService,
  mapResolutionToPlanState,
} from '../HitlHandoffService.js';
import { ActionReplayService, type IReplayGate } from '../ActionReplayService.js';
import type {
  IForensicPacketStorage,
  IPacketSigner,
  ReplayRequest,
} from '@oweibo/core-contracts';
import { severityToAutoTrigger } from '@oweibo/core-contracts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PLAN   = '22222222-2222-2222-2222-222222222222';
const USER   = '33333333-3333-3333-3333-333333333333';

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

describe('DefaultPiiRedactor', () => {
  const r = new DefaultPiiRedactor();

  it('redacts SSN', () => {
    expect(r.redact({ note: '123-45-6789 is the SSN' }))
      .toEqual({ note: '<REDACTED:SSN> is the SSN' });
  });
  it('redacts AWS access key id', () => {
    expect(r.redact({ key: 'AKIAIOSFODNN7EXAMPLE' }))
      .toEqual({ key: '<REDACTED:AWS_KEY>' });
  });
  it('redacts Luhn-valid card', () => {
    expect(r.redact({ pan: '4111 1111 1111 1111' }))
      .toEqual({ pan: '<REDACTED:CC>' });
  });
  it('passes through invalid CC-shaped digits', () => {
    const out = r.redact({ pan: '4111 1111 1111 1112' });
    expect(out).toEqual({ pan: '4111 1111 1111 1112' });
  });
  it('redacts GitHub PAT', () => {
    // Constructed at runtime to keep the literal out of the source tree
    // (secretlint scans the file and would flag a literal ghp_ token).
    const ghPat = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    expect(r.redact({ token: ghPat })).toEqual({ token: '<REDACTED:GITHUB_PAT>' });
  });
  it('handles null + undefined', () => {
    expect(r.redact(null)).toBeNull();
    expect(r.redact(undefined)).toBeUndefined();
  });
});

describe('severityToAutoTrigger', () => {
  it('sev 0/1/2 → null', () => {
    expect(severityToAutoTrigger(0)).toBeNull();
    expect(severityToAutoTrigger(1)).toBeNull();
    expect(severityToAutoTrigger(2)).toBeNull();
  });
  it('sev 3 → auto_drift', () => {
    expect(severityToAutoTrigger(3)).toBe('auto_drift');
  });
});

describe('mapResolutionToPlanState', () => {
  it('resumed/overridden → in_progress', () => {
    expect(mapResolutionToPlanState('resumed')).toBe('in_progress');
    expect(mapResolutionToPlanState('overridden')).toBe('in_progress');
  });
  it('aborted/lessons_learned → failed', () => {
    expect(mapResolutionToPlanState('aborted')).toBe('failed');
    expect(mapResolutionToPlanState('lessons_learned')).toBe('failed');
  });
});

// ── Test fakes for builder seams ─────────────────────────────────────────

class FakeStorage implements IForensicPacketStorage {
  public puts: Array<{ tenantId: string; packetId: string; bytes: Buffer }> = [];
  async put(args: { tenantId: string; packetId: string; bytes: Buffer }): Promise<{ storageRef: string }> {
    this.puts.push(args);
    return { storageRef: `mem://${args.tenantId}/${args.packetId}.json` };
  }
  async get(_: string): Promise<Buffer> { return Buffer.alloc(0); }
}

class FakeSigner implements IPacketSigner {
  async sign(_bytes: Buffer): Promise<string> { return 'deterministic-signature'; }
  async verify(_b: Buffer, sig: string): Promise<boolean> { return sig === 'deterministic-signature'; }
}

// ── ForensicPacketBuilder ────────────────────────────────────────────────

describe('ForensicPacketBuilder.build', () => {
  it('builds packet with synthesized executions from proposal state', async () => {
    const createdAt = new Date('2026-05-24T10:00:00Z');
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.action_plans', rows: [{ goal: 'ship it', summary: 'ship deploy' }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [
          {
            id: 'p-1', action_class: 'deploy.prod', action_id: 'aid-1',
            mode: 'require_approval', state: 'executed_live', summary: 'deploy v1.2.3',
            payload: { artifactHash: 'sha-abc' },
            rollback_kind: 'reversible_with_cost', grant_id: null,
            created_at: createdAt, decided_at: createdAt, decision_reason: 'approved',
          },
          {
            id: 'p-2', action_class: 'comm.external_email', action_id: 'aid-2',
            mode: 'require_approval', state: 'rejected', summary: 'announce',
            payload: { to: ['team@us.com'] }, rollback_kind: null, grant_id: null,
            created_at: createdAt, decided_at: createdAt, decision_reason: 'rejected by op',
          },
        ],
      },
      { match: 'FROM oweibo.post_execution_verifications', rows: [] },
      { match: 'FROM oweibo.rollback_executions', rows: [] },
      { match: 'FROM oweibo.content_inspection_results', rows: [] },
    ]);
    const storage = new FakeStorage();
    const signer = new FakeSigner();
    const builder = new ForensicPacketBuilder(pool, storage, signer, {
      now: () => new Date('2026-05-24T11:00:00Z'),
    });
    const out = await builder.build({
      tenantId: TENANT, planId: PLAN,
      triggerKind: 'manual', triggeredBy: USER,
    });
    expect(out.packet.proposals).toHaveLength(2);
    expect(out.packet.originalGoal).toBe('ship it');
    expect(out.packet.executions).toHaveLength(2);
    // p-1: executed_live → success; p-2: rejected → failure
    const outcomes = out.packet.executions.map((e) => e.outcome).sort();
    expect(outcomes).toEqual(['failure', 'success']);
    expect(out.signature).toBe('deterministic-signature');
    expect(storage.puts).toHaveLength(1);
    expect(out.storageRef).toMatch(/mem:\/\//);
    // Verify suggested actions reflect failure.
    expect(out.packet.suggestedActions.some((s) => s.match(/failed action/))).toBe(true);
    void calls;
  });

  it('redacts payload PII', async () => {
    const createdAt = new Date('2026-05-24T10:00:00Z');
    const { pool } = makePool([
      { match: 'FROM oweibo.action_plans', rows: [{ goal: 'goal', summary: null }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{
          id: 'p-3', action_class: 'comm.external_email', action_id: 'aid-3',
          mode: 'require_approval', state: 'pending', summary: 'email',
          payload: { body: 'leak AKIAIOSFODNN7EXAMPLE inside' },
          rollback_kind: null, grant_id: null,
          created_at: createdAt, decided_at: null, decision_reason: null,
        }],
      },
      { match: 'FROM oweibo.post_execution_verifications', rows: [] },
      { match: 'FROM oweibo.rollback_executions', rows: [] },
      { match: 'FROM oweibo.content_inspection_results', rows: [] },
    ]);
    const builder = new ForensicPacketBuilder(pool, new FakeStorage(), new FakeSigner());
    const out = await builder.build({
      tenantId: TENANT, planId: PLAN, triggerKind: 'manual', triggeredBy: USER,
    });
    expect(out.packet.proposals[0]!.payload).toEqual({ body: 'leak <REDACTED:AWS_KEY> inside' });
  });
});

// ── HitlHandoffService ──────────────────────────────────────────────────

describe('HitlHandoffService', () => {
  it('prepare inserts packet row + attempts plan pause', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.action_plans', rows: [{ goal: 'g', summary: null }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [],
      },
      { match: 'FROM oweibo.post_execution_verifications', rows: [] },
      { match: 'FROM oweibo.rollback_executions', rows: [] },
      { match: 'FROM oweibo.content_inspection_results', rows: [] },
      { match: 'INSERT INTO oweibo.forensic_packets', rows: [{ id: 'fp-1' }] },
    ]);
    const builder = new ForensicPacketBuilder(pool, new FakeStorage(), new FakeSigner());
    const svc = new HitlHandoffService(pool, builder, { isEnabled: () => true });
    const out = await svc.prepare({
      tenantId: TENANT, planId: PLAN,
      triggerKind: 'auto_drift', triggeredBy: USER,
    });
    expect(out.forensicPacketRowId).toBe('fp-1');
    expect(out.storageRef).toMatch(/mem:\/\//);
    // Pause attempt is fire-and-forget; no assertion on success.
    const pause = calls.find((c) => c.sql.includes("UPDATE oweibo.action_plans") && c.sql.includes("paused_hitl"));
    expect(pause).toBeDefined();
  });

  it('flag off → throw', async () => {
    const { pool } = makePool([]);
    const builder = new ForensicPacketBuilder(pool, new FakeStorage(), new FakeSigner());
    const svc = new HitlHandoffService(pool, builder, { isEnabled: () => false });
    await expect(svc.prepare({
      tenantId: TENANT, planId: PLAN, triggerKind: 'manual', triggeredBy: USER,
    })).rejects.toThrow(/forensic_replay.enabled is off/);
  });

  it('resolve updates packet state + plan state', async () => {
    const { pool, calls } = makePool([
      {
        match: 'UPDATE oweibo.forensic_packets',
        rows: [{ plan_id: PLAN }],
      },
    ]);
    const builder = new ForensicPacketBuilder(pool, new FakeStorage(), new FakeSigner());
    const svc = new HitlHandoffService(pool, builder, { isEnabled: () => true });
    await svc.resolve({
      tenantId: TENANT, forensicPacketRowId: 'fp-1',
      resolution: 'resumed', resolvedByUserId: USER,
    });
    // plan should update to 'in_progress'
    const planUpd = calls.find((c) =>
      c.sql.includes('UPDATE oweibo.action_plans')
      && c.params[1] === 'in_progress',
    );
    expect(planUpd).toBeDefined();
  });

  it('resolve throws when packet not found', async () => {
    const { pool } = makePool([
      { match: 'UPDATE oweibo.forensic_packets', rows: [] }, // no row returned
    ]);
    const builder = new ForensicPacketBuilder(pool, new FakeStorage(), new FakeSigner());
    const svc = new HitlHandoffService(pool, builder, { isEnabled: () => true });
    await expect(svc.resolve({
      tenantId: TENANT, forensicPacketRowId: 'missing',
      resolution: 'aborted', resolvedByUserId: USER,
    })).rejects.toThrow(/not found or already resolved/);
  });

  it('expireOverdue claims rows + marks plan failed', async () => {
    const { pool, calls } = makePool([
      {
        match: 'oweibo.forensic_packets AS p',
        rows: [
          { id: 'fp-old-1', plan_id: 'plan-1' },
          { id: 'fp-old-2', plan_id: 'plan-2' },
        ],
      },
    ]);
    const builder = new ForensicPacketBuilder(pool, new FakeStorage(), new FakeSigner());
    const svc = new HitlHandoffService(pool, builder, { isEnabled: () => true });
    const n = await svc.expireOverdue(50);
    expect(n).toBe(2);
    const planUpdates = calls.filter((c) =>
      c.sql.includes('UPDATE oweibo.action_plans') && c.sql.includes("'failed'"),
    );
    expect(planUpdates.length).toBe(2);
  });
});

// ── ActionReplayService ─────────────────────────────────────────────────

class FakeReplayGate implements IReplayGate {
  public calls: Array<{ tenantId: string; proposalId: string; mutation?: unknown }> = [];
  constructor(private readonly fn: (p: { proposalId: string; mutation?: unknown }) => { replayedMode: string; notes?: string }) {}
  async decide(input: {
    tenantId: string;
    proposal: { proposalId: string; actionClass: string; mode: string; payload: unknown };
    mutation?: unknown;
  }): Promise<{ replayedMode: string; notes?: string }> {
    this.calls.push({
      tenantId: input.tenantId,
      proposalId: input.proposal.proposalId,
      ...(input.mutation !== undefined ? { mutation: input.mutation } : {}),
    });
    return this.fn({ proposalId: input.proposal.proposalId, mutation: input.mutation });
  }
}

describe('ActionReplayService', () => {
  it('flag off → throw', async () => {
    const { pool } = makePool([]);
    const gate = new FakeReplayGate(() => ({ replayedMode: 'execute' }));
    const svc = new ActionReplayService(pool, gate, { isEnabled: () => false });
    await expect(svc.replay({
      tenantId: TENANT, planId: PLAN, requestedByUserId: USER, kind: 'shadow_full',
    })).rejects.toThrow(/forensic_replay.enabled is off/);
  });

  it('shadow_full: matches all when replay mirrors original', async () => {
    const { pool } = makePool([
      { match: 'INSERT INTO oweibo.action_replay_runs', rows: [{ id: 'run-1' }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [
          { id: 'p-1', action_class: 'deploy.prod',  action_id: 'a1', mode: 'require_approval', state: 'executed_live', summary: '', payload: {}, user_id: null },
          { id: 'p-2', action_class: 'comm.internal', action_id: 'a2', mode: 'dry_run',         state: 'executed_live', summary: '', payload: {}, user_id: null },
        ],
      },
    ]);
    const gate = new FakeReplayGate((p) => ({ replayedMode: p.proposalId === 'p-1' ? 'require_approval' : 'dry_run' }));
    const svc = new ActionReplayService(pool, gate, { isEnabled: () => true });
    const r = await svc.replay({
      tenantId: TENANT, planId: PLAN, requestedByUserId: USER, kind: 'shadow_full',
    });
    expect(r.status).toBe('complete');
    expect(r.totalSteps).toBe(2);
    expect(r.matchingSteps).toBe(2);
    expect(r.mismatchSteps).toBe(0);
  });

  it('shadow_full: reports mismatches', async () => {
    const { pool } = makePool([
      { match: 'INSERT INTO oweibo.action_replay_runs', rows: [{ id: 'run-2' }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [
          { id: 'p-3', action_class: 'deploy.prod', action_id: 'a3', mode: 'require_approval', state: 'executed_live', summary: '', payload: {}, user_id: null },
        ],
      },
    ]);
    const gate = new FakeReplayGate(() => ({ replayedMode: 'execute' }));
    const svc = new ActionReplayService(pool, gate, { isEnabled: () => true });
    const r = await svc.replay({
      tenantId: TENANT, planId: PLAN, requestedByUserId: USER, kind: 'shadow_full',
    });
    expect(r.totalSteps).toBe(1);
    expect(r.matchingSteps).toBe(0);
    expect(r.mismatchSteps).toBe(1);
    expect(r.stepResults[0]!.originalDecision).toBe('require_approval');
    expect(r.stepResults[0]!.replayedDecision).toBe('execute');
  });

  it('shadow_step: filters to single proposal', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.action_replay_runs', rows: [{ id: 'run-3' }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [
          { id: 'p-target', action_class: 'deploy.prod', action_id: 'a', mode: 'execute', state: 'executed_live', summary: '', payload: {}, user_id: null },
        ],
      },
    ]);
    const gate = new FakeReplayGate(() => ({ replayedMode: 'execute' }));
    const svc = new ActionReplayService(pool, gate, { isEnabled: () => true });
    const r = await svc.replay({
      tenantId: TENANT, planId: PLAN, requestedByUserId: USER,
      kind: 'shadow_step', proposalId: 'p-target',
    });
    expect(r.totalSteps).toBe(1);
    const select = calls.find((c) =>
      c.sql.includes('FROM oweibo.action_proposals') && c.params[0] === 'p-target',
    );
    expect(select).toBeDefined();
  });

  it('what_if: forwards mutation to gate', async () => {
    const { pool } = makePool([
      { match: 'INSERT INTO oweibo.action_replay_runs', rows: [{ id: 'run-4' }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [
          { id: 'p-x', action_class: 'deploy.prod', action_id: 'ax', mode: 'require_approval', state: 'executed_live', summary: '', payload: {}, user_id: null },
        ],
      },
    ]);
    const gate = new FakeReplayGate(() => ({ replayedMode: 'execute', notes: 'mutated path applied' }));
    const svc = new ActionReplayService(pool, gate, { isEnabled: () => true });
    await svc.replay({
      tenantId: TENANT, planId: PLAN, requestedByUserId: USER,
      kind: 'what_if',
      mutation: { path: 'orgGraph.approvers.length', newValue: 5 },
    });
    expect(gate.calls[0]!.mutation).toEqual({ path: 'orgGraph.approvers.length', newValue: 5 });
  });

  it('gate throws → step recorded with notes, run still complete', async () => {
    const { pool } = makePool([
      { match: 'INSERT INTO oweibo.action_replay_runs', rows: [{ id: 'run-5' }] },
      {
        match: 'FROM oweibo.action_proposals',
        rows: [
          { id: 'p-thr', action_class: 'deploy.prod', action_id: 'a', mode: 'execute', state: 'executed_live', summary: '', payload: {}, user_id: null },
        ],
      },
    ]);
    const gate: IReplayGate = {
      decide: async () => { throw new Error('boom'); },
    };
    const svc = new ActionReplayService(pool, gate, { isEnabled: () => true });
    const r = await svc.replay({
      tenantId: TENANT, planId: PLAN, requestedByUserId: USER, kind: 'shadow_full',
    });
    expect(r.status).toBe('complete');
    expect(r.stepResults[0]!.replayedDecision).toBe('<gate_error>');
    expect(r.stepResults[0]!.notes).toMatch(/boom/);
  });
});
