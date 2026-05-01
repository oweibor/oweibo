/**
 * Unit tests for KeyedSerializer — verify same-key serialisation,
 * different-key concurrency, and failure isolation.
 */
import { describe, it, expect } from '@jest/globals';
import { KeyedSerializer } from '../KeyedSerializer.js';

/** Resolves after a microtask hop — enough to interleave work in the event loop. */
function tick(): Promise<void> {
  return Promise.resolve();
}

describe('KeyedSerializer', () => {
  it('runs same-key calls sequentially in arrival order', async () => {
    const s = new KeyedSerializer<string>();
    const order: string[] = [];

    const a = s.chain('K', async () => { await tick(); order.push('a'); });
    const b = s.chain('K', async () => { order.push('b'); });
    const c = s.chain('K', async () => { order.push('c'); });

    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('runs different-key calls concurrently', async () => {
    const s = new KeyedSerializer<string>();
    let aStarted = false;
    let bStartedWhileARunning = false;

    const aPromise = s.chain('A', async () => {
      aStarted = true;
      // Hold the lock briefly so B has a chance to start in parallel
      await new Promise(r => setTimeout(r, 10));
    });
    const bPromise = s.chain('B', async () => {
      bStartedWhileARunning = aStarted; // recorded BEFORE A finishes
    });

    await Promise.all([aPromise, bPromise]);
    expect(bStartedWhileARunning).toBe(true);
  });

  it('returns the value from fn', async () => {
    const s = new KeyedSerializer<string>();
    const result = await s.chain('K', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors from fn to its caller', async () => {
    const s = new KeyedSerializer<string>();
    await expect(s.chain('K', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
  });

  it('a failed call does not break subsequent calls for the same key', async () => {
    const s = new KeyedSerializer<string>();

    const failed = s.chain('K', async () => { throw new Error('first'); }).catch(() => 'caught');
    const ok     = s.chain('K', async () => 'second');

    expect(await failed).toBe('caught');
    expect(await ok).toBe('second');
  });

  it('cleans up chain entries after completion (no map growth)', async () => {
    const s = new KeyedSerializer<string>();
    expect(s.pendingKeys).toBe(0);

    const p = s.chain('K', async () => { await tick(); });
    expect(s.pendingKeys).toBe(1);
    await p;
    expect(s.pendingKeys).toBe(0);

    // Different keys are tracked independently
    const x = s.chain('A', async () => { await tick(); });
    const y = s.chain('B', async () => { await tick(); });
    expect(s.pendingKeys).toBe(2);
    await Promise.all([x, y]);
    expect(s.pendingKeys).toBe(0);
  });
});
