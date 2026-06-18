/**
 * Unit tests for RedisTaskEventBusPublisher.
 *
 * Verifies channel, envelope shape, never-throws-on-failure, and clock
 * stamping. No live Redis.
 */
import {
  RedisTaskEventBusPublisher,
  TASK_EVENT_BUS_CHANNEL,
  TASK_APPROVAL_DECIDED_V1_SUBJECT,
  type RedisPublishFn,
} from '../RedisTaskEventBusPublisher.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PROPOSAL = '22222222-2222-2222-2222-222222222222';
const ACTION = '33333333-3333-3333-3333-333333333333';

const baseEvent = {
  tenantId: TENANT,
  proposalId: PROPOSAL,
  originatingTaskId: '44444444-4444-4444-4444-444444444444',
  actionId: ACTION,
  actionClass: 'deploy.prod.kube',
  decision: 'approved' as const,
  decidedByUserId: '55555555-5555-5555-5555-555555555555',
  reason: 'lgtm',
  decidedAtMs: 1_700_000_000_000,
};

describe('RedisTaskEventBusPublisher', () => {
  it('publishes to the v1 channel with a TaskEventEnvelopeV1 body', async () => {
    const calls: { channel: string; msg: string }[] = [];
    const publishFn: RedisPublishFn = async (channel, msg) => { calls.push({ channel, msg }); };
    const pub = new RedisTaskEventBusPublisher(publishFn, { now: () => 1_700_000_100_000 });

    await pub.publish(baseEvent);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe(TASK_EVENT_BUS_CHANNEL);
    expect(calls[0]!.channel).toBe('oweibo.task.events.v1');
    const env = JSON.parse(calls[0]!.msg) as {
      subject: string; publishedAtMs: number; payload: typeof baseEvent;
    };
    expect(env.subject).toBe(TASK_APPROVAL_DECIDED_V1_SUBJECT);
    expect(env.publishedAtMs).toBe(1_700_000_100_000);
    expect(env.payload).toEqual(baseEvent);
  });

  it('omits decidedByUserId / reason when callers omit them', async () => {
    const calls: { channel: string; msg: string }[] = [];
    const publishFn: RedisPublishFn = async (channel, msg) => { calls.push({ channel, msg }); };
    const pub = new RedisTaskEventBusPublisher(publishFn);

    await pub.publish({
      tenantId: TENANT,
      proposalId: PROPOSAL,
      originatingTaskId: null,
      actionId: ACTION,
      actionClass: 'deploy.prod.kube',
      decision: 'expired',
      decidedAtMs: 1,
    });

    const env = JSON.parse(calls[0]!.msg) as { payload: Record<string, unknown> };
    expect(env.payload.decidedByUserId).toBeUndefined();
    expect(env.payload.reason).toBeUndefined();
  });

  it('does not throw when the underlying publish fails — onError is invoked instead', async () => {
    const errs: { err: unknown; ctx: { tenantId: string; proposalId: string } }[] = [];
    const publishFn: RedisPublishFn = async () => { throw new Error('redis disconnected'); };
    const pub = new RedisTaskEventBusPublisher(publishFn, {
      onError: (err, ctx) => { errs.push({ err, ctx }); },
    });

    await expect(pub.publish(baseEvent)).resolves.toBeUndefined();
    expect(errs).toHaveLength(1);
    expect((errs[0]!.err as Error).message).toBe('redis disconnected');
    expect(errs[0]!.ctx).toEqual({ tenantId: TENANT, proposalId: PROPOSAL });
  });

  it('uses Date.now by default', async () => {
    const before = Date.now();
    const calls: string[] = [];
    const publishFn: RedisPublishFn = async (_c, msg) => { calls.push(msg); };
    const pub = new RedisTaskEventBusPublisher(publishFn);

    await pub.publish(baseEvent);
    const env = JSON.parse(calls[0]!) as { publishedAtMs: number };
    expect(env.publishedAtMs).toBeGreaterThanOrEqual(before);
    expect(env.publishedAtMs).toBeLessThanOrEqual(Date.now());
  });

  it('exposes CHANNEL as a static for subscribers', () => {
    expect(RedisTaskEventBusPublisher.CHANNEL).toBe(TASK_EVENT_BUS_CHANNEL);
  });

  it('default onError logs to console.warn (does not crash) on failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const publishFn: RedisPublishFn = async () => { throw new Error('boom'); };
      const pub = new RedisTaskEventBusPublisher(publishFn);
      await pub.publish(baseEvent);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]?.[0] ?? '');
      expect(msg).toMatch(/RedisTaskEventBusPublisher/);
      expect(msg).toMatch(/boom/);
      expect(msg).toMatch(/wake-up dropped/);
    } finally {
      warn.mockRestore();
    }
  });

  it('handles all decision kinds', async () => {
    const calls: string[] = [];
    const publishFn: RedisPublishFn = async (_c, msg) => { calls.push(msg); };
    const pub = new RedisTaskEventBusPublisher(publishFn);

    for (const decision of ['approved', 'rejected', 'expired', 'auto_promoted_via_grant'] as const) {
      await pub.publish({ ...baseEvent, decision });
    }
    const decisions = calls.map(c => (JSON.parse(c) as { payload: { decision: string } }).payload.decision);
    expect(decisions).toEqual(['approved', 'rejected', 'expired', 'auto_promoted_via_grant']);
  });
});
