/**
 * Unit tests for MemoryCircuitBreaker — verify the state machine and the
 * exec() wrapper using an injected clock.
 */
import { describe, it, expect } from '@jest/globals';
import {
  MemoryCircuitBreaker,
  MemoryCircuitOpenError,
} from '../MemoryCircuitBreaker.js';

function makeBreaker(now: () => number, opts: { failureThreshold?: number; cooldownMs?: number } = {}) {
  return new MemoryCircuitBreaker('test', {
    failureThreshold: opts.failureThreshold ?? 3,
    cooldownMs:       opts.cooldownMs       ?? 1000,
    now,
  });
}

describe('MemoryCircuitBreaker — state transitions', () => {
  it('starts CLOSED and allows calls', () => {
    const b = makeBreaker(() => 0);
    expect(b.getState()).toBe('closed');
    expect(b.allow()).toBe(true);
  });

  it('opens after N consecutive failures', () => {
    const b = makeBreaker(() => 0, { failureThreshold: 3 });
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('closed');
    b.recordFailure();
    expect(b.getState()).toBe('open');
    expect(b.allow()).toBe(false);
  });

  it('successful calls reset the failure counter', () => {
    const b = makeBreaker(() => 0, { failureThreshold: 3 });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    // 2 fresh failures < threshold; should still be CLOSED
    expect(b.getState()).toBe('closed');
  });

  it('transitions OPEN → HALF_OPEN after the cooldown elapses', () => {
    let now = 1000;
    const b = makeBreaker(() => now, { failureThreshold: 1, cooldownMs: 500 });
    b.recordFailure();
    expect(b.getState()).toBe('open');

    now = 1400; // 400ms — still cooling
    expect(b.getState()).toBe('open');

    now = 1600; // cooldown elapsed
    expect(b.getState()).toBe('half_open');
  });

  it('a HALF_OPEN failure re-opens immediately', () => {
    let now = 1000;
    const b = makeBreaker(() => now, { failureThreshold: 1, cooldownMs: 500 });
    b.recordFailure();
    now = 1600;
    expect(b.getState()).toBe('half_open');
    b.recordFailure();
    expect(b.getState()).toBe('open');
  });

  it('a HALF_OPEN success closes the breaker', () => {
    let now = 1000;
    const b = makeBreaker(() => now, { failureThreshold: 1, cooldownMs: 500 });
    b.recordFailure();
    now = 1600;
    expect(b.getState()).toBe('half_open');
    b.recordSuccess();
    expect(b.getState()).toBe('closed');
  });
});

describe('MemoryCircuitBreaker.exec', () => {
  it('passes through when CLOSED and the call succeeds', async () => {
    const b = makeBreaker(() => 0);
    const result = await b.exec(async () => 42);
    expect(result).toBe(42);
    expect(b.getState()).toBe('closed');
  });

  it('throws fast with MemoryCircuitOpenError when OPEN', async () => {
    const b = makeBreaker(() => 0, { failureThreshold: 1 });
    b.recordFailure(); // → open
    await expect(b.exec(async () => 'never')).rejects.toBeInstanceOf(MemoryCircuitOpenError);
  });

  it('counts a thrown failure toward the breaker', async () => {
    const b = makeBreaker(() => 0, { failureThreshold: 2 });
    await expect(b.exec(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(b.getState()).toBe('closed');
    await expect(b.exec(async () => { throw new Error('y'); })).rejects.toThrow('y');
    expect(b.getState()).toBe('open');
  });

  it('rethrows the underlying error (not MemoryCircuitOpenError) on first failures', async () => {
    const b = makeBreaker(() => 0, { failureThreshold: 5 });
    const err = new Error('downstream');
    await expect(b.exec(async () => { throw err; })).rejects.toBe(err);
  });
});
