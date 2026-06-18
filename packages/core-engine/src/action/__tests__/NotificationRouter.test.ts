/**
 * S.1 — NotificationRouter tests.
 *
 * Covers:
 *   - first successful channel per recipient wins
 *   - failed channel falls back to in_app
 *   - quiet hours suppress non-urgent dispatches; expiry (urgent) bypasses
 *   - fire-event bucketing filters channels by `fireOn`
 *   - dispatch log writes one row per attempt
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { NotificationRouter, fireEventBucket } from '../NotificationRouter.js';
import type {
  ApprovalSlaPolicy,
  DispatchResult,
  INotificationChannel,
  NotificationChannelKind,
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PROPOSAL = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

function makePool(): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

function makeChannel(
  kind: NotificationChannelKind,
  result: DispatchResult,
): { adapter: INotificationChannel; calls: NotificationDispatchRequest[] } {
  const calls: NotificationDispatchRequest[] = [];
  const adapter: INotificationChannel = {
    kind,
    async dispatch(req) { calls.push(req); return result; },
  };
  return { adapter, calls };
}

function makePolicy(overrides: Partial<ApprovalSlaPolicy> = {}): ApprovalSlaPolicy {
  return {
    tenantId: TENANT,
    actionClass: 'financial.payment',
    initialNotifyAfterSeconds: 0,
    escalateAfterSeconds: [60, 120],
    hardExpireAfterSeconds: 3600,
    approverResolution: 'role_based',
    approverConfig: {},
    notificationChannels: [
      { channelKind: 'slack', config: {}, fireOn: ['initial', 'escalation', 'expiry'] },
      { channelKind: 'in_app', config: {}, fireOn: ['initial', 'escalation', 'expiry'] },
    ],
    ...overrides,
  };
}

describe('fireEventBucket', () => {
  it('maps escalation:N to "escalation"', () => {
    expect(fireEventBucket('escalation:1')).toBe('escalation');
    expect(fireEventBucket('escalation:5')).toBe('escalation');
  });

  it('passes initial/expiry/decision through unchanged', () => {
    expect(fireEventBucket('initial')).toBe('initial');
    expect(fireEventBucket('expiry')).toBe('expiry');
    expect(fireEventBucket('decision')).toBe('decision');
  });
});

describe('NotificationRouter.route', () => {
  const silentLog = () => undefined;

  it('uses the first successful channel and stops trying further channels', async () => {
    const { pool } = makePool();
    const slack = makeChannel('slack', { status: 'delivered' });
    const inApp = makeChannel('in_app', { status: 'delivered' });
    const router = new NotificationRouter(pool, {
      channels: new Map<NotificationChannelKind, INotificationChannel>([
        ['slack', slack.adapter], ['in_app', inApp.adapter],
      ]),
      log: silentLog,
    });
    const result = await router.route({
      tenantId: TENANT, proposalId: PROPOSAL, fireEvent: 'initial',
      title: 't', body: 'b', policy: makePolicy(),
      recipients: [{ userId: USER }],
    });
    expect(slack.calls).toHaveLength(1);
    expect(inApp.calls).toHaveLength(0); // slack succeeded → in_app not tried
    expect(result.dispatched).toBe(1);
  });

  it('falls back to in_app when first channel fails', async () => {
    const { pool } = makePool();
    const slack = makeChannel('slack', { status: 'failed', error: 'slack down' });
    const inApp = makeChannel('in_app', { status: 'delivered' });
    const router = new NotificationRouter(pool, {
      channels: new Map<NotificationChannelKind, INotificationChannel>([
        ['slack', slack.adapter], ['in_app', inApp.adapter],
      ]),
      log: silentLog,
    });
    const result = await router.route({
      tenantId: TENANT, proposalId: PROPOSAL, fireEvent: 'initial',
      title: 't', body: 'b', policy: makePolicy(),
      recipients: [{ userId: USER }],
    });
    expect(slack.calls).toHaveLength(1);
    expect(inApp.calls).toHaveLength(1);
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('suppresses non-urgent dispatches during quiet hours', async () => {
    const fixedNow = new Date('2026-01-23T03:00:00Z'); // 03:00 UTC
    const { pool } = makePool();
    const slack = makeChannel('slack', { status: 'delivered' });
    const inApp = makeChannel('in_app', { status: 'delivered' });
    const router = new NotificationRouter(pool, {
      channels: new Map<NotificationChannelKind, INotificationChannel>([
        ['slack', slack.adapter], ['in_app', inApp.adapter],
      ]),
      now: () => fixedNow,
      log: silentLog,
    });
    const result = await router.route({
      tenantId: TENANT, proposalId: PROPOSAL, fireEvent: 'initial',
      title: 't', body: 'b',
      policy: makePolicy({ quietHours: { tz: 'UTC', startHour: 1, endHour: 6 } }),
      recipients: [{ userId: USER }],
    });
    expect(slack.calls).toHaveLength(0);
    expect(inApp.calls).toHaveLength(0);
    expect(result.suppressed).toBeGreaterThan(0);
  });

  it('expiry (urgent) bypasses quiet hours', async () => {
    const fixedNow = new Date('2026-01-23T03:00:00Z');
    const { pool } = makePool();
    const inApp = makeChannel('in_app', { status: 'delivered' });
    const router = new NotificationRouter(pool, {
      channels: new Map<NotificationChannelKind, INotificationChannel>([['in_app', inApp.adapter]]),
      now: () => fixedNow,
      log: silentLog,
    });
    const result = await router.route({
      tenantId: TENANT, proposalId: PROPOSAL, fireEvent: 'expiry',
      title: 't', body: 'b',
      policy: makePolicy({ quietHours: { tz: 'UTC', startHour: 1, endHour: 6 } }),
      recipients: [{ userId: USER }],
    });
    expect(inApp.calls).toHaveLength(1);
    expect(result.dispatched).toBe(1);
    expect(inApp.calls[0]?.urgency).toBe('urgent');
  });

  it('skips channels whose fireOn does not include the current bucket', async () => {
    const { pool } = makePool();
    const decisionOnly = makeChannel('webhook', { status: 'delivered' });
    const inApp = makeChannel('in_app', { status: 'delivered' });
    const router = new NotificationRouter(pool, {
      channels: new Map<NotificationChannelKind, INotificationChannel>([
        ['webhook', decisionOnly.adapter], ['in_app', inApp.adapter],
      ]),
      log: silentLog,
    });
    await router.route({
      tenantId: TENANT, proposalId: PROPOSAL, fireEvent: 'initial',
      title: 't', body: 'b',
      policy: makePolicy({
        notificationChannels: [
          { channelKind: 'webhook', config: {}, fireOn: ['decision'] }, // not initial
          { channelKind: 'in_app', config: {}, fireOn: ['initial'] },
        ],
      }),
      recipients: [{ userId: USER }],
    });
    expect(decisionOnly.calls).toHaveLength(0);
    expect(inApp.calls).toHaveLength(1);
  });

  it('uses in-app fallback when no policy channels matched the bucket', async () => {
    const { pool } = makePool();
    const inApp = makeChannel('in_app', { status: 'delivered' });
    const router = new NotificationRouter(pool, {
      channels: new Map<NotificationChannelKind, INotificationChannel>([['in_app', inApp.adapter]]),
      log: silentLog,
    });
    const result = await router.route({
      tenantId: TENANT, proposalId: PROPOSAL, fireEvent: 'initial',
      title: 't', body: 'b',
      policy: makePolicy({
        notificationChannels: [
          { channelKind: 'webhook', config: {}, fireOn: ['decision'] },
        ],
      }),
      recipients: [{ userId: USER }],
    });
    expect(inApp.calls).toHaveLength(1);
    expect(result.dispatched).toBe(1);
  });

  it('writes a dispatch-log row for every attempt', async () => {
    const { pool, calls } = makePool();
    const inApp = makeChannel('in_app', { status: 'delivered' });
    const router = new NotificationRouter(pool, {
      channels: new Map<NotificationChannelKind, INotificationChannel>([['in_app', inApp.adapter]]),
      log: silentLog,
    });
    await router.route({
      tenantId: TENANT, proposalId: PROPOSAL, fireEvent: 'initial',
      title: 't', body: 'b',
      policy: makePolicy({
        notificationChannels: [{ channelKind: 'in_app', config: {}, fireOn: ['initial'] }],
      }),
      recipients: [{ userId: USER }],
    });
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.notification_dispatch_log'))).toBe(true);
  });
});
