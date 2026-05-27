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

  // Audit-fix (S.2): pin the cold-start ramp formula to its boundary
  // values so future refactors don't silently change the curve. Formula:
  //
  //   day < N/2:        multiplier = coldStartMultiplier (flat)
  //   N/2 <= day < N:   multiplier = m + ((day - N/2) / (N/2)) * (1 - m)
  //   day >= N:         multiplier = 1.0
  //
  // For the audit's example (m=0.25, N=14, day=10):
  //   ramp = (10 - 7) / 7 = 3/7 ≈ 0.4286
  //   eff  = 0.25 + 0.4286 * 0.75 = 0.5714
  //   capacity 100 → floor(100 * 0.5714) = 57
  describe('audit-fix: boundary values of the linear ramp', () => {
    const m = 0.25;
    const N = 14;
    const auditPolicy = { coldStartMultiplier: m, coldStartDurationDays: N };

    it('day 0 → flat multiplier', () => {
      const now = new Date('2026-01-01T00:00:00Z');
      expect(applyColdStart(100, auditPolicy, created, now)).toBe(25);
    });

    it('day N/2 = 7 → still at flat multiplier (start of ramp)', () => {
      const now = new Date('2026-01-08T00:00:00Z'); // day 7
      expect(applyColdStart(100, auditPolicy, created, now)).toBe(25);
    });

    it('day 10 (audit example) → 57', () => {
      const now = new Date('2026-01-11T00:00:00Z'); // day 10
      expect(applyColdStart(100, auditPolicy, created, now)).toBe(57);
    });

    it('day N = 14 → full capacity', () => {
      const now = new Date('2026-01-15T00:00:00Z'); // day 14
      expect(applyColdStart(100, auditPolicy, created, now)).toBe(100);
    });

    it('day N+1 → full capacity', () => {
      const now = new Date('2026-01-16T00:00:00Z'); // day 15
      expect(applyColdStart(100, auditPolicy, created, now)).toBe(100);
    });
  });
});
