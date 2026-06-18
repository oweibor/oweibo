/**
 * F.4.4: pure-function tests for the four PLATFORM_MIN_MATRIX floor
 * checks. Each matrix is exercised across at-floor, below-floor, and
 * above-floor inputs to lock in the invariants the route handler
 * relies on.
 *
 * Field semantics:
 *
 *   SLA       — hardExpireAfterSeconds is a MIN (must be ≥ floor),
 *               initialNotifyAfterSeconds is a MAX (must be ≤ ceiling)
 *   Multi-pty — quorum MIN; maxGrantDurationSeconds MAX. Both apply
 *               only to floored classes (`irreversible.*`, `financial.payment`)
 *   Ratelimit — perMinute MIN; enforcementMode set membership
 *   Quota     — limitValue MIN; coldStartLimit MIN (when set);
 *               coldStartDurationDays MIN (≥ 0)
 */
import {
  SLA_PLATFORM_MIN_MATRIX,
  checkSlaPolicyAgainstFloor,
} from '../ApprovalSlaService.js';
import {
  MULTI_PARTY_PLATFORM_MIN_MATRIX,
  multiPartyFloorsApplyTo,
  checkMultiPartyPolicyAgainstFloor,
} from '../MultiPartyApprovalService.js';
import {
  RATE_LIMIT_PLATFORM_MIN_MATRIX,
  checkRateLimitPolicyAgainstFloor,
} from '../RateLimitPolicy.js';
import {
  QUOTA_PLATFORM_MIN_MATRIX,
  checkQuotaPolicyAgainstFloor,
} from '../QuotaService.js';

// ── SLA floors ───────────────────────────────────────────────────────────

describe('F.4.4 SLA floor', () => {
  const ok = {
    hardExpireAfterSeconds: SLA_PLATFORM_MIN_MATRIX.hardExpireAfterSecondsMin,
    initialNotifyAfterSeconds: 30,
  };

  it('accepts an at-floor policy', () => {
    expect(checkSlaPolicyAgainstFloor(ok)).toEqual([]);
  });

  it('rejects hardExpireAfterSeconds below 3600', () => {
    const v = checkSlaPolicyAgainstFloor({ ...ok, hardExpireAfterSeconds: 3599 });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('hardExpireAfterSeconds');
    expect(v[0]?.floor).toBe(3600);
    expect(v[0]?.supplied).toBe(3599);
  });

  it('accepts hardExpireAfterSeconds above floor (looser-but-platform-bounded)', () => {
    expect(checkSlaPolicyAgainstFloor({ ...ok, hardExpireAfterSeconds: 7200 })).toEqual([]);
  });

  it('rejects initialNotifyAfterSeconds above the ceiling (silence too long)', () => {
    const v = checkSlaPolicyAgainstFloor({
      ...ok, initialNotifyAfterSeconds: SLA_PLATFORM_MIN_MATRIX.initialNotifyAfterSecondsMax + 1,
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('initialNotifyAfterSeconds');
  });

  it('reports both violations simultaneously', () => {
    const v = checkSlaPolicyAgainstFloor({
      hardExpireAfterSeconds: 100,
      initialNotifyAfterSeconds: 999999,
    });
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.field).sort()).toEqual(['hardExpireAfterSeconds', 'initialNotifyAfterSeconds']);
  });

  it('floor message names the supplied + floor values for operator readability', () => {
    const v = checkSlaPolicyAgainstFloor({ ...ok, hardExpireAfterSeconds: 100 });
    expect(v[0]?.message).toContain('hardExpireAfterSeconds');
  });
});

// ── Multi-party floors ───────────────────────────────────────────────────

describe('F.4.4 multi-party floor', () => {
  const safePolicy = {
    quorum: MULTI_PARTY_PLATFORM_MIN_MATRIX.quorumMin,
    maxGrantDurationSeconds: MULTI_PARTY_PLATFORM_MIN_MATRIX.maxGrantDurationSecondsMax,
  };

  it('multiPartyFloorsApplyTo() matches the floored class prefixes', () => {
    expect(multiPartyFloorsApplyTo('irreversible.delete_resource')).toBe(true);
    expect(multiPartyFloorsApplyTo('financial.payment')).toBe(true);
    expect(multiPartyFloorsApplyTo('financial.adjustment')).toBe(false);
    expect(multiPartyFloorsApplyTo('comm.external_email')).toBe(false);
  });

  it('returns no violations for unfloored classes regardless of values', () => {
    const v = checkMultiPartyPolicyAgainstFloor('comm.external_email', {
      quorum: 0, maxGrantDurationSeconds: 10000000,
    });
    expect(v).toEqual([]);
  });

  it('accepts an at-floor policy for a floored class', () => {
    expect(checkMultiPartyPolicyAgainstFloor('financial.payment', safePolicy)).toEqual([]);
  });

  it('rejects quorum < 2 for floored classes', () => {
    const v = checkMultiPartyPolicyAgainstFloor('financial.payment', {
      ...safePolicy, quorum: 1,
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('quorum');
  });

  it('rejects maxGrantDurationSeconds > 24h for floored classes', () => {
    const v = checkMultiPartyPolicyAgainstFloor('irreversible.public_publish', {
      ...safePolicy, maxGrantDurationSeconds: 86401,
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('maxGrantDurationSeconds');
  });

  it('reports both violations for a doubly-weak floored policy', () => {
    const v = checkMultiPartyPolicyAgainstFloor('irreversible.', {
      quorum: 1, maxGrantDurationSeconds: 7 * 86400,
    });
    expect(v).toHaveLength(2);
  });
});

// ── Rate-limit floors ────────────────────────────────────────────────────

describe('F.4.4 rate-limit floor', () => {
  const ok = { perMinute: 1, enforcementMode: 'soft' as const };

  it('accepts an at-floor policy', () => {
    expect(checkRateLimitPolicyAgainstFloor(ok)).toEqual([]);
  });

  it('rejects perMinute < 1', () => {
    const v = checkRateLimitPolicyAgainstFloor({ ...ok, perMinute: 0 });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('perMinute');
  });

  it('rejects enforcementMode outside {soft, hard}', () => {
    const v = checkRateLimitPolicyAgainstFloor({ ...ok, enforcementMode: 'observe' as never });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('enforcementMode');
    expect(v[0]?.floor).toEqual(['soft', 'hard']);
  });

  it('accepts hard enforcement', () => {
    expect(checkRateLimitPolicyAgainstFloor({ ...ok, enforcementMode: 'hard' as const })).toEqual([]);
  });

  it('reports both violations together for a max-bad policy', () => {
    const v = checkRateLimitPolicyAgainstFloor({ perMinute: 0, enforcementMode: 'noop' as never });
    expect(v).toHaveLength(2);
  });

  it('platform floor matrix is frozen at the documented values', () => {
    expect(RATE_LIMIT_PLATFORM_MIN_MATRIX.perMinuteMin).toBe(1);
    expect(RATE_LIMIT_PLATFORM_MIN_MATRIX.allowedEnforcementModes).toEqual(['soft', 'hard']);
  });
});

// ── Quota floors ─────────────────────────────────────────────────────────

describe('F.4.4 quota floor', () => {
  const ok = {
    limitValue: 1,
    coldStartLimit: 1,
    coldStartDurationDays: 30,
  };

  it('accepts an at-floor policy', () => {
    expect(checkQuotaPolicyAgainstFloor(ok)).toEqual([]);
  });

  it('rejects limitValue < 1', () => {
    const v = checkQuotaPolicyAgainstFloor({ ...ok, limitValue: 0 });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('limitValue');
  });

  it('rejects limitValue < 0 (no negative caps)', () => {
    const v = checkQuotaPolicyAgainstFloor({ ...ok, limitValue: -5 });
    expect(v[0]?.field).toBe('limitValue');
    expect(v[0]?.supplied).toBe(-5);
  });

  it('accepts null/undefined coldStartLimit (no separate cold-start cap)', () => {
    expect(checkQuotaPolicyAgainstFloor({ ...ok, coldStartLimit: undefined })).toEqual([]);
    expect(checkQuotaPolicyAgainstFloor({ ...ok, coldStartLimit: null as unknown as number })).toEqual([]);
  });

  it('rejects coldStartLimit < 1 when set', () => {
    const v = checkQuotaPolicyAgainstFloor({ ...ok, coldStartLimit: 0 });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('coldStartLimit');
  });

  it('rejects negative coldStartDurationDays', () => {
    const v = checkQuotaPolicyAgainstFloor({ ...ok, coldStartDurationDays: -1 });
    expect(v).toHaveLength(1);
    expect(v[0]?.field).toBe('coldStartDurationDays');
  });

  it('reports every violation present', () => {
    const v = checkQuotaPolicyAgainstFloor({
      limitValue: 0, coldStartLimit: -10, coldStartDurationDays: -3,
    });
    expect(v).toHaveLength(3);
    expect(v.map((x) => x.field).sort()).toEqual(
      ['coldStartDurationDays', 'coldStartLimit', 'limitValue'],
    );
  });

  it('platform floor matrix is frozen at the documented values', () => {
    expect(QUOTA_PLATFORM_MIN_MATRIX.limitValueMin).toBe(1);
    expect(QUOTA_PLATFORM_MIN_MATRIX.coldStartLimitMin).toBe(1);
    expect(QUOTA_PLATFORM_MIN_MATRIX.coldStartDurationDaysMin).toBe(0);
  });
});
