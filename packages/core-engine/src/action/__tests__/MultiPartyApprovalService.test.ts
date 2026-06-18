/**
 * S.4 — MultiPartyApprovalService tests.
 *
 * Covers:
 *   - Policy resolution: tenant exact → tenant '*' → platform matrix → fallback
 *   - Grant consumption: feature flag, scope filter, atomic increment, exhaustion
 *   - Grant creation: policy enforcement (caps, quorum, allowGrants)
 *   - Vote tally: quorum reached, dissent veto, pending
 *   - Delegation: refuses self, refuses when policy disallows, requires active row
 *   - Scope filter pure helper: eq / in / matches; missing field returns undefined
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  MultiPartyApprovalService,
  platformDefaultMultiPartyPolicy,
  matchesScope,
  tallyToStatus,
} from '../MultiPartyApprovalService.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ALICE  = '22222222-2222-2222-2222-222222222222';
const BOB    = '33333333-3333-3333-3333-333333333333';
const CARLA  = '44444444-4444-4444-4444-444444444444';
const PROP   = '55555555-5555-5555-5555-555555555555';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs
      .filter((s) => sql.includes(s.match))
      .sort((a, b) => b.match.length - a.match.length)[0];
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
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('platformDefaultMultiPartyPolicy', () => {
  it('matches financial.payment to quorum 2', () => {
    const p = platformDefaultMultiPartyPolicy(TENANT, 'financial.payment');
    expect(p.quorum).toBe(2);
    expect(p.allowGrants).toBe(false);
  });

  it('matches deploy.prod to quorum 2', () => {
    const p = platformDefaultMultiPartyPolicy(TENANT, 'deploy.prod');
    expect(p.quorum).toBe(2);
    expect(p.allowGrants).toBe(true);
  });

  it('longest prefix wins: irreversible.delete_resource is quorum 2', () => {
    const p = platformDefaultMultiPartyPolicy(TENANT, 'irreversible.delete_resource');
    expect(p.quorum).toBe(2);
  });

  it('unknown class falls back to quorum 1', () => {
    const p = platformDefaultMultiPartyPolicy(TENANT, 'read.local');
    expect(p.quorum).toBe(1);
    expect(p.allowGrants).toBe(true);
  });
});

describe('matchesScope', () => {
  it('no filter matches anything', () => {
    expect(matchesScope({ x: 1 })).toBe(true);
  });

  it('eq matches deep equal', () => {
    expect(matchesScope(
      { payload: { table: 'users' } },
      { fieldPath: 'payload.table', operator: 'eq', value: 'users' },
    )).toBe(true);
    expect(matchesScope(
      { payload: { table: 'users' } },
      { fieldPath: 'payload.table', operator: 'eq', value: 'accounts' },
    )).toBe(false);
  });

  it('in matches value membership', () => {
    expect(matchesScope(
      { payload: { table: 'users' } },
      { fieldPath: 'payload.table', operator: 'in', value: ['users', 'accounts'] },
    )).toBe(true);
    expect(matchesScope(
      { payload: { table: 'orders' } },
      { fieldPath: 'payload.table', operator: 'in', value: ['users', 'accounts'] },
    )).toBe(false);
  });

  it('matches regex against string-coerced field', () => {
    expect(matchesScope(
      { payload: { path: '/foo/bar' } },
      { fieldPath: 'payload.path', operator: 'matches', value: '^/foo/' },
    )).toBe(true);
    expect(matchesScope(
      { payload: { path: '/baz' } },
      { fieldPath: 'payload.path', operator: 'matches', value: '^/foo/' },
    )).toBe(false);
  });

  it('missing field path returns undefined, eq false unless target is undefined', () => {
    expect(matchesScope(
      { payload: {} },
      { fieldPath: 'payload.nope', operator: 'eq', value: 'x' },
    )).toBe(false);
  });

  it('invalid regex source returns false', () => {
    expect(matchesScope(
      { payload: { p: 'x' } },
      { fieldPath: 'payload.p', operator: 'matches', value: '(' },
    )).toBe(false);
  });
});

describe('tallyToStatus', () => {
  const policy = platformDefaultMultiPartyPolicy(TENANT, 'deploy.prod'); // quorum 2, dissentVetoes true

  it('rejects on any dissent when dissentVetoes', () => {
    const s = tallyToStatus(3, 1, policy);
    expect(s.kind).toBe('rejected');
    if (s.kind === 'rejected') expect(s.reason).toBe('dissent_veto');
  });

  it('approves when approves >= quorum', () => {
    expect(tallyToStatus(2, 0, policy).kind).toBe('approved');
  });

  it('pending when below quorum', () => {
    expect(tallyToStatus(1, 0, policy).kind).toBe('pending');
  });

  it('dissentVetoes false → reject only counts but does not veto', () => {
    const p = { ...policy, dissentVetoes: false };
    expect(tallyToStatus(2, 5, p).kind).toBe('approved');
  });
});

// ── Service: tryConsume ──────────────────────────────────────────────────

describe('MultiPartyApprovalService.tryConsume', () => {
  it('flag off → always no_grant (no DB query)', async () => {
    const { pool, calls } = makePool([]);
    const svc = new MultiPartyApprovalService(pool, { isEnabled: () => false });
    const result = await svc.tryConsume({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedToKind: 'agent',
      payload: {},
    });
    expect(result).toEqual({ kind: 'no_grant' });
    expect(calls.length).toBe(0);
  });

  it('no candidate grants → no_grant', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool, { isEnabled: () => true });
    const result = await svc.tryConsume({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedToKind: 'agent',
      payload: {},
    });
    expect(result).toEqual({ kind: 'no_grant' });
  });

  it('matching candidate with no scope filter → grant_consumed', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.time_windowed_grants',
        rows: [{ id: 'g-1', action_class: 'write.tenant_db.prod', scope_filter: null, max_uses: 100, uses: 0 }],
      },
      {
        match: 'UPDATE oweibo.time_windowed_grants',
        rows: [{ id: 'g-1' }],
      },
    ]);
    const svc = new MultiPartyApprovalService(pool, { isEnabled: () => true });
    const result = await svc.tryConsume({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedToKind: 'agent',
      payload: { table: 'users' },
    });
    expect(result).toEqual({ kind: 'grant_consumed', grantId: 'g-1' });
  });

  it('scope filter mismatch → skipped, no claim', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.time_windowed_grants',
        rows: [
          {
            id: 'g-mismatch',
            action_class: 'write.tenant_db.prod',
            scope_filter: { fieldPath: 'payload.table', operator: 'eq', value: 'users' },
            max_uses: 10,
            uses: 0,
          },
        ],
      },
    ]);
    const svc = new MultiPartyApprovalService(pool, { isEnabled: () => true });
    const result = await svc.tryConsume({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedToKind: 'agent',
      payload: { payload: { table: 'orders' } },
    });
    expect(result).toEqual({ kind: 'no_grant' });
    expect(calls.some((c) => c.sql.includes('UPDATE oweibo.time_windowed_grants'))).toBe(false);
  });

  it('atomic claim races: UPDATE returns no row → skipped to next', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.time_windowed_grants',
        rows: [
          { id: 'g-raced', action_class: 'write.tenant_db.prod', scope_filter: null, max_uses: 1, uses: 0 },
        ],
      },
      // UPDATE returns empty rows (race lost)
      { match: 'UPDATE oweibo.time_windowed_grants', rows: [] },
    ]);
    const svc = new MultiPartyApprovalService(pool, { isEnabled: () => true });
    const result = await svc.tryConsume({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedToKind: 'agent',
      payload: {},
    });
    expect(result).toEqual({ kind: 'no_grant' });
  });
});

// ── Service: createGrant ─────────────────────────────────────────────────

describe('MultiPartyApprovalService.createGrant', () => {
  it('refuses when policy.allowGrants = false (financial.payment platform default)', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.createGrant({
      tenantId: TENANT,
      actionClass: 'financial.payment',
      grantedByUserIds: [ALICE, BOB],
      grantedToKind: 'agent',
      durationSeconds: 60,
      maxUses: 1,
    })).rejects.toThrow(/grants disabled/);
  });

  it('refuses when duration exceeds cap', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    // write.tenant_db.prod cap = 4h = 14400s
    await expect(svc.createGrant({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedByUserIds: [ALICE],
      grantedToKind: 'agent',
      durationSeconds: 24 * 60 * 60,
      maxUses: 10,
    })).rejects.toThrow(/exceeds policy cap/);
  });

  it('refuses when maxUses exceeds cap', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.createGrant({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedByUserIds: [ALICE],
      grantedToKind: 'agent',
      durationSeconds: 60,
      maxUses: 10_000, // > 500 cap
    })).rejects.toThrow(/exceeds policy cap/);
  });

  it('refuses when grantedByUserIds count < quorum (deploy.prod needs 2)', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.createGrant({
      tenantId: TENANT,
      actionClass: 'deploy.prod',
      grantedByUserIds: [ALICE], // only 1, need 2
      grantedToKind: 'agent',
      durationSeconds: 60,
      maxUses: 1,
    })).rejects.toThrow(/requires 2 (distinct )?approver/);
  });

  it('refuses when grantedToKind=user without grantedToUserId', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.createGrant({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedByUserIds: [ALICE],
      grantedToKind: 'user',
      durationSeconds: 60,
      maxUses: 5,
    })).rejects.toThrow(/grantedToKind='user' requires/);
  });

  it('happy path: writes grant row and returns hydrated record', async () => {
    const createdAt = new Date('2026-05-24T10:00:00Z');
    const { pool } = makePool([
      {
        match: 'INSERT INTO oweibo.time_windowed_grants',
        rows: [{ id: 'g-new', created_at: createdAt }],
      },
    ]);
    const svc = new MultiPartyApprovalService(pool, { now: () => new Date('2026-05-24T10:00:00Z') });
    const grant = await svc.createGrant({
      tenantId: TENANT,
      actionClass: 'write.tenant_db.prod',
      grantedByUserIds: [ALICE],
      grantedToKind: 'agent',
      scopeFilter: { fieldPath: 'payload.table', operator: 'eq', value: 'users' },
      durationSeconds: 60 * 60,
      maxUses: 100,
    });
    expect(grant.id).toBe('g-new');
    expect(grant.state).toBe('active');
    expect(grant.uses).toBe(0);
    expect(grant.scopeFilter).toEqual({
      fieldPath: 'payload.table',
      operator: 'eq',
      value: 'users',
    });
    expect(new Date(grant.expiresAt).getTime()).toBe(createdAt.getTime() + 60 * 60 * 1000);
  });
});

// ── Service: castVote ────────────────────────────────────────────────────

describe('MultiPartyApprovalService.castVote', () => {
  it('refuses when proposal not found', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.castVote({
      tenantId: TENANT,
      proposalId: PROP,
      voterUserId: ALICE,
      vote: 'approve',
    })).rejects.toThrow(/not found/);
  });

  it('insert + tally returns pending when below quorum', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{ action_class: 'deploy.prod', state: 'pending' }],
      },
      {
        match: 'GROUP BY vote',
        rows: [{ vote: 'approve', n: 1 }],
      },
    ]);
    const svc = new MultiPartyApprovalService(pool);
    const status = await svc.castVote({
      tenantId: TENANT,
      proposalId: PROP,
      voterUserId: ALICE,
      vote: 'approve',
    });
    expect(status.kind).toBe('pending');
    if (status.kind === 'pending') {
      expect(status.approves).toBe(1);
      expect(status.quorum).toBe(2);
    }
  });

  it('approves at quorum', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{ action_class: 'deploy.prod', state: 'pending' }],
      },
      {
        match: 'GROUP BY vote',
        rows: [{ vote: 'approve', n: 2 }],
      },
    ]);
    const svc = new MultiPartyApprovalService(pool);
    const status = await svc.castVote({
      tenantId: TENANT,
      proposalId: PROP,
      voterUserId: BOB,
      vote: 'approve',
    });
    expect(status.kind).toBe('approved');
  });

  it('rejects on dissent veto', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{ action_class: 'deploy.prod', state: 'pending' }],
      },
      {
        match: 'GROUP BY vote',
        rows: [{ vote: 'approve', n: 1 }, { vote: 'reject', n: 1 }],
      },
    ]);
    const svc = new MultiPartyApprovalService(pool);
    const status = await svc.castVote({
      tenantId: TENANT,
      proposalId: PROP,
      voterUserId: CARLA,
      vote: 'reject',
    });
    expect(status.kind).toBe('rejected');
    if (status.kind === 'rejected') expect(status.reason).toBe('dissent_veto');
  });

  it('delegation: refuses when policy disallows', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{ action_class: 'financial.payment', state: 'pending' }], // allowDelegation=false
      },
    ]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.castVote({
      tenantId: TENANT,
      proposalId: PROP,
      voterUserId: BOB,
      vote: 'approve',
      onBehalfOf: ALICE,
    })).rejects.toThrow(/delegation disabled/);
  });

  it('delegation: refuses when no active row', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{ action_class: 'deploy.prod', state: 'pending' }],
      },
      // No delegation row returned
      { match: 'FROM oweibo.approval_delegations', rows: [] },
    ]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.castVote({
      tenantId: TENANT,
      proposalId: PROP,
      voterUserId: BOB,
      vote: 'approve',
      onBehalfOf: ALICE,
    })).rejects.toThrow(/no active delegation/);
  });

  it('delegation: honors active row', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.action_proposals',
        rows: [{ action_class: 'deploy.prod', state: 'pending' }],
      },
      { match: 'FROM oweibo.approval_delegations', rows: [{ ok: true }] },
      { match: 'GROUP BY vote', rows: [{ vote: 'approve', n: 1 }] },
    ]);
    const svc = new MultiPartyApprovalService(pool);
    const status = await svc.castVote({
      tenantId: TENANT,
      proposalId: PROP,
      voterUserId: BOB,
      vote: 'approve',
      onBehalfOf: ALICE,
    });
    expect(status.kind).toBe('pending');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.approval_votes'));
    expect(insert).toBeDefined();
    // via_delegation true; delegator_user_id = ALICE
    expect(insert!.params[5]).toBe(true);
    expect(insert!.params[6]).toBe(ALICE);
  });
});

// ── Service: createDelegation ────────────────────────────────────────────

describe('MultiPartyApprovalService.createDelegation', () => {
  it('refuses self-delegation', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.createDelegation({
      tenantId: TENANT,
      delegatorUserId: ALICE,
      delegateUserId: ALICE,
      actionClass: 'deploy.prod',
      durationSeconds: 60,
    })).rejects.toThrow(/cannot delegate to self/);
  });

  it('refuses when policy.allowDelegation = false (financial.payment)', async () => {
    const { pool } = makePool([]);
    const svc = new MultiPartyApprovalService(pool);
    await expect(svc.createDelegation({
      tenantId: TENANT,
      delegatorUserId: ALICE,
      delegateUserId: BOB,
      actionClass: 'financial.payment',
      durationSeconds: 60,
    })).rejects.toThrow(/delegation disabled/);
  });

  it('inserts delegation row when allowed', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.approval_delegations', rows: [] },
    ]);
    const svc = new MultiPartyApprovalService(pool, { now: () => new Date('2026-05-24T10:00:00Z') });
    await svc.createDelegation({
      tenantId: TENANT,
      delegatorUserId: ALICE,
      delegateUserId: BOB,
      actionClass: 'deploy.prod',
      durationSeconds: 60 * 60,
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.approval_delegations'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe(ALICE);
    expect(insert!.params[1]).toBe(BOB);
  });
});

// ── Service: revokeGrant ─────────────────────────────────────────────────

describe('MultiPartyApprovalService.revokeGrant', () => {
  it('issues UPDATE setting state=revoked', async () => {
    const { pool, calls } = makePool([
      { match: 'UPDATE oweibo.time_windowed_grants', rows: [] },
    ]);
    const svc = new MultiPartyApprovalService(pool);
    await svc.revokeGrant(TENANT, 'g-1', ALICE);
    const upd = calls.find((c) => c.sql.includes('UPDATE oweibo.time_windowed_grants'));
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain("'revoked'");
    expect(upd!.params).toEqual(['g-1', TENANT, ALICE]);
  });
});
