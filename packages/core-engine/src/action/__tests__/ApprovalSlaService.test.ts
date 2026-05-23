/**
 * S.1 — ApprovalSlaService tests.
 *
 * Covers:
 *   - platformDefaultPolicy: prefix matching, fallback default, channel set
 *   - resolvePolicy: exact > '*' > platform fallback
 *   - attachSla: idempotent INSERT with computed next_action_at + hard_expire_at
 *   - flag-off short-circuits attachSla
 *   - advanceStage: null delay parks at hard_expire_at
 *   - isInQuietHours: simple window, wrap-around window, unknown tz
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  ApprovalSlaService,
  platformDefaultPolicy,
  isInQuietHours,
} from '../ApprovalSlaService.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface QueryStub { match: string; rows: QueryResultRow[]; }

function makePool(stubs: QueryStub[]): {
  pool: Pool; calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
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

describe('platformDefaultPolicy', () => {
  it('uses the financial.* row for financial.payment', () => {
    const p = platformDefaultPolicy(TENANT, 'financial.payment');
    expect(p.initialNotifyAfterSeconds).toBe(0);
    expect(p.hardExpireAfterSeconds).toBe(48 * 60 * 60);
    expect(p.approverResolution).toBe('org_graph');
  });

  it('uses the personnel.* row for personnel.access_grant', () => {
    const p = platformDefaultPolicy(TENANT, 'personnel.access_grant');
    expect(p.hardExpireAfterSeconds).toBe(72 * 60 * 60);
  });

  it('uses deploy.prod over deploy. when both could match (longest prefix wins)', () => {
    const p = platformDefaultPolicy(TENANT, 'deploy.prod');
    expect(p.hardExpireAfterSeconds).toBe(8 * 60 * 60);
  });

  it('falls back to role_based 7-day default for unknown classes', () => {
    const p = platformDefaultPolicy(TENANT, 'unclassified');
    expect(p.approverResolution).toBe('role_based');
    expect(p.hardExpireAfterSeconds).toBe(7 * 24 * 60 * 60);
  });

  it('every default includes an in_app notification channel', () => {
    const p = platformDefaultPolicy(TENANT, 'financial.payment');
    expect(p.notificationChannels.some((c) => c.channelKind === 'in_app')).toBe(true);
  });
});

describe('ApprovalSlaService.resolvePolicy', () => {
  it('returns platform default when no DB row matches', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.approval_sla_policies', rows: [] },
    ]);
    const svc = new ApprovalSlaService(pool, { isEnabled: () => true });
    const p = await svc.resolvePolicy(TENANT, 'financial.payment');
    expect(p.hardExpireAfterSeconds).toBe(48 * 60 * 60); // platform matrix
  });

  it('prefers the exact-class row over * (ORDER BY ... DESC LIMIT 1)', async () => {
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.approval_sla_policies',
        rows: [{
          id: 'pol-1',
          action_class: 'financial.payment',
          initial_notify_after_seconds: 30,
          escalate_after_seconds: [120, 240],
          hard_expire_after_seconds: 600,
          approver_resolution: 'explicit_list',
          approver_config: { users: ['u1'] },
          notification_channels: [],
          quiet_hours: null,
        }],
      },
    ]);
    const svc = new ApprovalSlaService(pool, { isEnabled: () => true });
    const p = await svc.resolvePolicy(TENANT, 'financial.payment');
    expect(p.actionClass).toBe('financial.payment');
    expect(p.hardExpireAfterSeconds).toBe(600);
    const query = calls.find((c) => c.sql.includes('FROM oweibo.approval_sla_policies'));
    expect(query?.sql).toMatch(/ORDER BY \(action_class = \$2\) DESC/);
  });
});

describe('ApprovalSlaService.attachSla', () => {
  it('short-circuits when flag is off (no INSERT)', async () => {
    const { pool, calls } = makePool([]);
    const svc = new ApprovalSlaService(pool, { isEnabled: () => false });
    await svc.attachSla('p1', TENANT, 'financial.payment');
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.approval_sla_state'))).toBe(false);
  });

  it('inserts a state row with computed next_action_at and hard_expire_at', async () => {
    const fixedNow = new Date('2026-05-23T10:00:00Z');
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.approval_sla_policies', rows: [] },
    ]);
    const svc = new ApprovalSlaService(pool, {
      isEnabled: () => true,
      now: () => fixedNow,
    });
    await svc.attachSla(
      '00000000-0000-0000-0000-000000000aaa',
      TENANT,
      'write.tenant_db.prod', // 60s initial, 4h hard
    );
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.approval_sla_state'));
    expect(insert).toBeDefined();
    const params = insert!.params;
    expect(params[0]).toBe('00000000-0000-0000-0000-000000000aaa');
    expect((params[3] as Date).getTime()).toBe(fixedNow.getTime() + 60 * 1000);
    expect((params[4] as Date).getTime()).toBe(fixedNow.getTime() + 4 * 60 * 60 * 1000);
  });

  it('uses ON CONFLICT DO NOTHING so re-runs are idempotent', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.approval_sla_policies', rows: [] },
    ]);
    const svc = new ApprovalSlaService(pool, { isEnabled: () => true });
    await svc.attachSla('00000000-0000-0000-0000-000000000aaa', TENANT, 'comm.external_email');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.approval_sla_state'));
    expect(insert?.sql).toMatch(/ON CONFLICT \(proposal_id\) DO NOTHING/);
  });
});

describe('ApprovalSlaService.advanceStage', () => {
  it('writes new_stage and notified_approvers union', async () => {
    const { pool, calls } = makePool([]);
    const svc = new ApprovalSlaService(pool, { isEnabled: () => true });
    await svc.advanceStage({
      tenantId: TENANT,
      proposalId: '00000000-0000-0000-0000-000000000aaa',
      newStage: 2,
      escalationDelaySeconds: 600,
      notifiedApprovers: ['u1', 'u2'],
      details: { fireEvent: 'escalation:1' },
    });
    const upd = calls.find((c) => c.sql.includes('UPDATE oweibo.approval_sla_state'));
    expect(upd).toBeDefined();
    expect(upd?.params[1]).toBe(2);
    expect(upd?.params[3]).toEqual(['u1', 'u2']);
  });

  it('with null delay, parks the row at hard_expire_at (COALESCE)', async () => {
    const { pool, calls } = makePool([]);
    const svc = new ApprovalSlaService(pool, { isEnabled: () => true });
    await svc.advanceStage({
      tenantId: TENANT,
      proposalId: '00000000-0000-0000-0000-000000000aaa',
      newStage: 5,
      escalationDelaySeconds: null,
      notifiedApprovers: [],
    });
    const upd = calls.find((c) => c.sql.includes('UPDATE oweibo.approval_sla_state'));
    expect(upd?.sql).toMatch(/COALESCE\(\$3, hard_expire_at\)/);
    expect(upd?.params[2]).toBeNull();
  });
});

describe('isInQuietHours', () => {
  it('returns false when no quiet hours configured', () => {
    expect(isInQuietHours(new Date('2026-05-23T02:00:00Z'), undefined)).toBe(false);
  });

  it('detects a simple daytime window in UTC', () => {
    // 02:00 UTC is 02:00 in Europe/London (BST aside) — pick UTC tz for stability.
    const at = new Date('2026-01-23T02:00:00Z');
    expect(isInQuietHours(at, { tz: 'UTC', startHour: 1, endHour: 5 })).toBe(true);
    expect(isInQuietHours(at, { tz: 'UTC', startHour: 5, endHour: 9 })).toBe(false);
  });

  it('handles wrap-around windows (22:00..06:00)', () => {
    const at23 = new Date('2026-01-23T23:00:00Z');
    const at03 = new Date('2026-01-23T03:00:00Z');
    const at12 = new Date('2026-01-23T12:00:00Z');
    expect(isInQuietHours(at23, { tz: 'UTC', startHour: 22, endHour: 6 })).toBe(true);
    expect(isInQuietHours(at03, { tz: 'UTC', startHour: 22, endHour: 6 })).toBe(true);
    expect(isInQuietHours(at12, { tz: 'UTC', startHour: 22, endHour: 6 })).toBe(false);
  });

  it('startHour === endHour means no window (avoid lockout)', () => {
    expect(isInQuietHours(new Date(), { tz: 'UTC', startHour: 12, endHour: 12 })).toBe(false);
  });

  it('falls open for an unknown timezone', () => {
    expect(
      isInQuietHours(new Date('2026-01-23T03:00:00Z'),
        { tz: 'Not/A_Real_Zone', startHour: 0, endHour: 6 }),
    ).toBe(false);
  });
});
