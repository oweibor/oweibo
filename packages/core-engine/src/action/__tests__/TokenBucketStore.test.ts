/**
 * S.2 — InMemoryTokenBucketStore tests.
 *
 * Covers: refill math, three-window all-or-nothing semantics,
 * retryAfterMs computation, capacity reduction clipping.
 */
import { InMemoryTokenBucketStore } from '../TokenBucketStore.js';

const TENANT = 'tenant-a';
const CLASS = 'write.local.scratch';

describe('InMemoryTokenBucketStore.tryConsume', () => {
  it('first request creates the bucket and consumes one token', async () => {
    const store = new InMemoryTokenBucketStore();
    const r = await store.tryConsume({
      tenantId: TENANT, actionClass: CLASS,
      buckets: [{ window: 'minute', capacity: 10 }],
    });
    expect(r.allowed).toBe(true);
  });

  it('refuses when the bucket is empty + returns retryAfterMs proportional to refill rate', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    for (let i = 0; i < 60; i++) {
      const r = await store.tryConsume({
        tenantId: TENANT, actionClass: CLASS,
        buckets: [{ window: 'minute', capacity: 60 }],
      });
      expect(r.allowed).toBe(true);
    }
    const r61 = await store.tryConsume({
      tenantId: TENANT, actionClass: CLASS,
      buckets: [{ window: 'minute', capacity: 60 }],
    });
    expect(r61.allowed).toBe(false);
    expect(r61.limitingWindow).toBe('minute');
    // 60 tokens / 60_000ms = 1 token / 1000ms → 1 token wait ~ 1000ms
    expect(r61.retryAfterMs).toBeGreaterThan(900);
    expect(r61.retryAfterMs).toBeLessThan(1100);
  });

  it('refills tokens over time', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    for (let i = 0; i < 60; i++) {
      await store.tryConsume({
        tenantId: TENANT, actionClass: CLASS,
        buckets: [{ window: 'minute', capacity: 60 }],
      });
    }
    // Advance 30s → should refill 30 tokens
    nowMs += 30_000;
    const r = await store.tryConsume({
      tenantId: TENANT, actionClass: CLASS,
      buckets: [{ window: 'minute', capacity: 60 }],
    });
    expect(r.allowed).toBe(true);
  });

  it('all-or-nothing across multiple windows — none consumed if any empty', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });

    // Drain the per-day bucket first by setting capacity = 2 and consuming 2.
    await store.tryConsume({
      tenantId: TENANT, actionClass: CLASS,
      buckets: [
        { window: 'minute', capacity: 100 },
        { window: 'hour',   capacity: 100 },
        { window: 'day',    capacity: 2 },
      ],
    });
    await store.tryConsume({
      tenantId: TENANT, actionClass: CLASS,
      buckets: [
        { window: 'minute', capacity: 100 },
        { window: 'hour',   capacity: 100 },
        { window: 'day',    capacity: 2 },
      ],
    });

    // Day bucket now empty. Next call should be refused with limitingWindow=day.
    const r = await store.tryConsume({
      tenantId: TENANT, actionClass: CLASS,
      buckets: [
        { window: 'minute', capacity: 100 },
        { window: 'hour',   capacity: 100 },
        { window: 'day',    capacity: 2 },
      ],
    });
    expect(r.allowed).toBe(false);
    expect(r.limitingWindow).toBe('day');

    // Minute and hour buckets should not have been decremented by the
    // refused call — verify by checking we still have ~98 minute tokens.
    const consumption = await store.consumption({
      tenantId: TENANT, actionClass: CLASS,
      capacities: { minute: 100, hour: 100, day: 2 },
    });
    expect(consumption.minute.used).toBe(2);
    expect(consumption.hour.used).toBe(2);
    expect(consumption.day.used).toBe(2);
  });

  it('clips tokens when capacity decreases (cold-start ramp down)', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryTokenBucketStore({ now: () => new Date(nowMs) });
    // Establish bucket at capacity 100, consume 0 so tokens = 100.
    await store.consumption({
      tenantId: TENANT, actionClass: CLASS,
      capacities: { minute: 100, hour: 100, day: 100 },
    });
    // Reduce capacity to 10 — tokens must clip to 10, not stay at 100.
    const c = await store.consumption({
      tenantId: TENANT, actionClass: CLASS,
      capacities: { minute: 10, hour: 10, day: 10 },
    });
    expect(c.minute.capacity).toBe(10);
    expect(c.minute.used).toBe(0);
  });
});

describe('InMemoryTokenBucketStore.consumption', () => {
  it('reports used + capacity per window', async () => {
    // Freeze the clock so the refill between tryConsume and consumption
    // doesn't add fractional tokens back -- CI's higher event-loop
    // latency exposed `expect(used).toBe(1)` failing as 0.9998... when
    // the real wall-clock elapsed between the two calls.
    const frozenNow = new Date('2026-05-30T12:00:00Z');
    const store = new InMemoryTokenBucketStore({ now: () => frozenNow });
    await store.tryConsume({
      tenantId: TENANT, actionClass: CLASS,
      buckets: [
        { window: 'minute', capacity: 10 },
        { window: 'hour',   capacity: 100 },
        { window: 'day',    capacity: 1000 },
      ],
    });
    const c = await store.consumption({
      tenantId: TENANT, actionClass: CLASS,
      capacities: { minute: 10, hour: 100, day: 1000 },
    });
    expect(c.minute.used).toBe(1);
    expect(c.hour.used).toBe(1);
    expect(c.day.used).toBe(1);
  });
});
