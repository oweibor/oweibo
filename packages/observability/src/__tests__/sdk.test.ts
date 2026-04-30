import { describe, it, expect, afterEach } from 'vitest';

// SDK init has real side-effects (binds ports, spawns exporters).
// We test only the module shape and the resetSdk guard.
describe('sdk module', () => {
  afterEach(async () => {
    const { resetSdk } = await import('../sdk.js');
    resetSdk();
  });

  it('exports initOtel as a function', async () => {
    const { initOtel } = await import('../sdk.js');
    expect(typeof initOtel).toBe('function');
  });

  it('exports resetSdk as a function', async () => {
    const { resetSdk } = await import('../sdk.js');
    expect(typeof resetSdk).toBe('function');
  });

  it('resetSdk is idempotent', async () => {
    const { resetSdk } = await import('../sdk.js');
    expect(() => { resetSdk(); resetSdk(); }).not.toThrow();
  });
});
