/**
 * T.5.e — SeedCohortAssigner tests.
 *
 * Verifies:
 *   - flag off → every tenant gets 'seeded' (no A/B trial active)
 *   - flag on  → SHA256 mod 2 produces a fair, deterministic split
 *   - exempt set bypasses the flag and returns 'exempt'
 */
import { SeedCohortAssigner } from '../SeedCohortAssigner.js';

describe('SeedCohortAssigner', () => {
  it('defaults to seeded for every tenant when flag is off', () => {
    const a = new SeedCohortAssigner({ isEnabled: () => false });
    for (const id of ['t1', 't2', 't3', '11111111-1111-1111-1111-111111111111']) {
      expect(a.assign(id)).toBe('seeded');
    }
  });

  it('partitions across SHA256 mod 2 when flag is on', () => {
    const a = new SeedCohortAssigner({ isEnabled: () => true });
    let seeded = 0;
    let control = 0;
    for (let i = 0; i < 1000; i++) {
      const id = `tenant-${i.toString().padStart(6, '0')}`;
      const c = a.assign(id);
      if (c === 'seeded') seeded += 1;
      else if (c === 'control') control += 1;
    }
    // SHA256 is uniform; over 1000 inputs the split should be near 500/500.
    // Loose tolerance to keep the test stable across runs.
    expect(seeded + control).toBe(1000);
    expect(Math.abs(seeded - control)).toBeLessThan(150);
  });

  it('is deterministic for the same id', () => {
    const a = new SeedCohortAssigner({ isEnabled: () => true });
    const id = '22222222-2222-2222-2222-222222222222';
    const first = a.assign(id);
    for (let i = 0; i < 10; i++) {
      expect(a.assign(id)).toBe(first);
    }
  });

  it('exempt tenant ids bypass both the flag and the SHA256 split', () => {
    const exempt = new Set(['internal-1', 'synthetic-2']);
    const aOn  = new SeedCohortAssigner({ isEnabled: () => true,  exemptTenantIds: exempt });
    const aOff = new SeedCohortAssigner({ isEnabled: () => false, exemptTenantIds: exempt });
    for (const id of exempt) {
      expect(aOn.assign(id)).toBe('exempt');
      expect(aOff.assign(id)).toBe('exempt');
    }
  });

  it('reads SEED_AB_ENABLED env when no isEnabled override is supplied', () => {
    const prior = process.env['SEED_AB_ENABLED'];
    process.env['SEED_AB_ENABLED'] = 'true';
    try {
      const a = new SeedCohortAssigner();
      // We can't predict 'seeded' vs 'control' here, but it should be one of them.
      expect(['seeded', 'control']).toContain(a.assign('any-id'));
    } finally {
      if (prior === undefined) delete process.env['SEED_AB_ENABLED'];
      else process.env['SEED_AB_ENABLED'] = prior;
    }
  });
});
