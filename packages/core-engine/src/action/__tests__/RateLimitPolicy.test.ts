/**
 * S.2 — RateLimitPolicy: default matrix + cold-start ramp.
 */
import {
  platformDefaultRateLimit,
  applyColdStart,
} from '../RateLimitPolicy.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('platformDefaultRateLimit', () => {
  it('matches read.* with loose limits', () => {
    const p = platformDefaultRateLimit(TENANT, 'read.tenant_db');
    expect(p.perMinute).toBe(600);
    expect(p.coldStartMultiplier).toBe(0.50);
    expect(p.enforcementMode).toBe('soft');
  });

  it('matches irreversible.* with strictest limits + hard enforcement', () => {
    const p = platformDefaultRateLimit(TENANT, 'irreversible.delete_resource');
    expect(p.perMinute).toBe(2);
    expect(p.coldStartMultiplier).toBe(0.05);
    expect(p.enforcementMode).toBe('hard');
  });

  it('longest-prefix wins: write.local.repo_prod over write.local', () => {
    const repo = platformDefaultRateLimit(TENANT, 'write.local.repo_prod');
    const scratch = platformDefaultRateLimit(TENANT, 'write.local.scratch');
    expect(repo.perMinute).toBe(60);
    expect(scratch.perMinute).toBe(200);
  });

  it('falls back to conservative defaults for unknown classes', () => {
    const p = platformDefaultRateLimit(TENANT, 'unclassified');
    expect(p.perMinute).toBe(10);
    expect(p.enforcementMode).toBe('soft');
  });

  it('write.tenant_db.* uses tightened budget vs read.*', () => {
    const w = platformDefaultRateLimit(TENANT, 'write.tenant_db.prod');
    const r = platformDefaultRateLimit(TENANT, 'read.tenant_db');
    expect(w.perMinute).toBeLessThan(r.perMinute);
  });
});

describe('applyColdStart', () => {
  const policy = { coldStartMultiplier: 0.25, coldStartDurationDays: 10 };
  const created = new Date('2026-01-01T00:00:00Z');

  it('returns full capacity when cold-start duration is 0 (no ramp)', () => {
    expect(applyColdStart(100, { coldStartMultiplier: 0.5, coldStartDurationDays: 0 }, created, new Date())).toBe(100);
  });

  it('applies multiplier in the first half of the window', () => {
    const now = new Date('2026-01-04T00:00:00Z'); // day 3 of 10 (first half)
    expect(applyColdStart(100, policy, created, now)).toBe(25);
  });

  it('returns full capacity after the cold-start window', () => {
    const now = new Date('2026-01-15T00:00:00Z'); // day 14 > 10
    expect(applyColdStart(100, policy, created, now)).toBe(100);
  });

  it('ramps linearly from multiplier to 1.0 in the second half', () => {
    // day 7.5 of 10 — halfway through the ramp window (5..10):
    // effective = 0.25 + 0.5 * (1 - 0.25) = 0.625
    const now = new Date('2026-01-08T12:00:00Z');
    expect(applyColdStart(100, policy, created, now)).toBe(62);
  });

  it('returns at least 1 when capacity * multiplier rounds down to 0', () => {
    expect(applyColdStart(5, { coldStartMultiplier: 0.05, coldStartDurationDays: 30 }, created, new Date('2026-01-02T00:00:00Z'))).toBe(1);
  });
});
