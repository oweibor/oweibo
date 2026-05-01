/**
 * Tests for wireMemorySubsystem — verify the orchestrator is constructed with
 * the right tier set under different config combinations, and that the
 * lifecycle methods schedule/clear background services correctly.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { wireMemorySubsystem } from '../MemoryWiring.js';

// Minimal Redis duck-type — STM and ProjectRegistry only call a small subset.
function makeRedis(): any {
  return {
    rpush:     jest.fn<() => Promise<number>>().mockResolvedValue(1),
    lrange:    jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    ltrim:     jest.fn<() => Promise<unknown>>().mockResolvedValue('OK'),
    llen:      jest.fn<() => Promise<number>>().mockResolvedValue(0),
    hset:      jest.fn<() => Promise<number>>().mockResolvedValue(1),
    hgetall:   jest.fn<() => Promise<Record<string, string>>>().mockResolvedValue({}),
    expire:    jest.fn<() => Promise<number>>().mockResolvedValue(1),
    zadd:      jest.fn<() => Promise<number>>().mockResolvedValue(1),
    zrevrange: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    del:       jest.fn<() => Promise<number>>().mockResolvedValue(1),
    sadd:      jest.fn<() => Promise<number>>().mockResolvedValue(1),
    srem:      jest.fn<() => Promise<number>>().mockResolvedValue(1),
    smembers:  jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
    set:       jest.fn<() => Promise<unknown>>().mockResolvedValue('OK'),
    get:       jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  };
}

const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('wireMemorySubsystem — tier composition', () => {
  it('returns an orchestrator with no semantic tier when QDRANT_URL is absent', async () => {
    const sub = await wireMemorySubsystem({ redis: makeRedis(), logger: SILENT_LOGGER });
    expect(sub.orchestrator).toBeDefined();
    expect(sub.semantic).toBeNull();
    expect(sub.services.warmer).toBeUndefined();
    expect(sub.services.consolidator).toBeUndefined();
    sub.stop();
  });

  it('returns an orchestrator with no semantic tier when embedder is missing', async () => {
    // qdrantUrl present, but no embedder/ollamaUrl
    const sub = await wireMemorySubsystem({
      redis: makeRedis(),
      qdrantUrl: 'http://qdrant:6333',
      logger: SILENT_LOGGER,
    });
    expect(sub.semantic).toBeNull();
    sub.stop();
  });

  it('wires the semantic tier when both qdrant and embedder are present', async () => {
    const embedder = jest.fn<(t: string) => Promise<number[]>>().mockResolvedValue([0.1, 0.2]);
    const sub = await wireMemorySubsystem({
      redis: makeRedis(),
      qdrantUrl: 'http://qdrant:6333',
      embedder,
      logger: SILENT_LOGGER,
    });
    expect(sub.semantic).not.toBeNull();
    expect(sub.services.warmer).toBeDefined();
    expect(sub.services.consolidator).toBeDefined();
    expect(sub.services.promoter).toBeDefined();
    sub.stop();
  });

  it('does not start MemoryDecayService without a pgPool', async () => {
    const embedder = jest.fn<(t: string) => Promise<number[]>>().mockResolvedValue([0.1]);
    const sub = await wireMemorySubsystem({
      redis: makeRedis(),
      qdrantUrl: 'http://qdrant:6333',
      embedder,
      logger: SILENT_LOGGER,
    });
    expect(sub.services.decay).toBeUndefined();
    sub.stop();
  });
});

describe('wireMemorySubsystem — lifecycle', () => {
  it('start() schedules cycles; stop() clears them', async () => {
    const embedder = jest.fn<(t: string) => Promise<number[]>>().mockResolvedValue([0.1]);
    const sub = await wireMemorySubsystem({
      redis: makeRedis(),
      qdrantUrl: 'http://qdrant:6333',
      embedder,
      logger: SILENT_LOGGER,
      schedules: { consolidatorMs: 100, promoterMs: 100 },
    });

    const consolidatorSpy = jest.spyOn(sub.services.consolidator!, 'runConsolidationCycle')
      .mockResolvedValue();
    const promoterSpy     = jest.spyOn(sub.services.promoter!, 'runPromotionCycle')
      .mockResolvedValue();

    sub.start();
    jest.advanceTimersByTime(250);

    expect(consolidatorSpy).toHaveBeenCalled();
    expect(promoterSpy).toHaveBeenCalled();

    consolidatorSpy.mockClear();
    promoterSpy.mockClear();
    sub.stop();
    jest.advanceTimersByTime(500);

    expect(consolidatorSpy).not.toHaveBeenCalled();
    expect(promoterSpy).not.toHaveBeenCalled();
  });

  it('start() is a no-op when no semantic tier was wired', async () => {
    const sub = await wireMemorySubsystem({ redis: makeRedis(), logger: SILENT_LOGGER });
    expect(() => sub.start()).not.toThrow();
    expect(() => sub.stop()).not.toThrow();
  });
});

describe('wireMemorySubsystem — orchestrator behaviour', () => {
  it('orchestrator.record on a non-routed kind returns synthesised entry when no semantic', async () => {
    const sub = await wireMemorySubsystem({ redis: makeRedis(), logger: SILENT_LOGGER });
    const entry = await sub.orchestrator.record({
      scope:      { tenantId: 't-1' },
      kind:       'failure-lesson',
      summary:    'something failed',
      importance: 0.5,
    });
    expect(entry.id).toBeTruthy();
    expect(entry.kind).toBe('failure-lesson');
    expect(entry.recallCount).toBe(0);
    sub.stop();
  });

  it('orchestrator.assembleContext returns empty memories when no semantic tier', async () => {
    const sub = await wireMemorySubsystem({ redis: makeRedis(), logger: SILENT_LOGGER });
    const ctx = await sub.orchestrator.assembleContext({
      scope: { tenantId: 't-1' },
      query: 'anything',
    });
    expect(ctx.rankedMemories).toEqual([]);
    expect(typeof ctx.promptBlock).toBe('string');
    sub.stop();
  });
});
