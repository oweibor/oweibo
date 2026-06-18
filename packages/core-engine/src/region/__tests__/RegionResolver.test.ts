/**
 * T.8: RegionResolver unit tests.
 */
import { RegionResolver, REGION_NEUTRAL } from '../RegionResolver.js';

describe('RegionResolver.canonical', () => {
  it('lowercases and trims', () => {
    expect(RegionResolver.canonical('  US-East-1 ')).toBe('us-east-1');
  });

  it('treats null/undefined/empty as the neutral marker', () => {
    expect(RegionResolver.canonical(null)).toBe(REGION_NEUTRAL);
    expect(RegionResolver.canonical(undefined)).toBe(REGION_NEUTRAL);
    expect(RegionResolver.canonical('')).toBe(REGION_NEUTRAL);
    expect(RegionResolver.canonical('   ')).toBe(REGION_NEUTRAL);
  });
});

describe('RegionResolver.membership', () => {
  it('us-east-1 maps to {*, us-east-1, us-*}', () => {
    const m = RegionResolver.membership('us-east-1');
    expect(new Set(m)).toEqual(new Set(['*', 'us-east-1', 'us-*']));
  });

  it('eu-central-1 maps to {*, eu-central-1, eu-*}', () => {
    const m = RegionResolver.membership('eu-central-1');
    expect(new Set(m)).toEqual(new Set(['*', 'eu-central-1', 'eu-*']));
  });

  it('ap-southeast-2 maps to {*, ap-southeast-2, ap-*}', () => {
    const m = RegionResolver.membership('ap-southeast-2');
    expect(new Set(m)).toEqual(new Set(['*', 'ap-southeast-2', 'ap-*']));
  });

  it('unknown region maps only to itself + neutral', () => {
    const m = RegionResolver.membership('xx-unknown-9');
    expect(new Set(m)).toEqual(new Set(['*', 'xx-unknown-9']));
  });

  it('null/undefined region only matches the neutral marker', () => {
    expect(RegionResolver.membership(null)).toEqual(['*']);
    expect(RegionResolver.membership(undefined)).toEqual(['*']);
  });
});

describe('RegionResolver.appliesTo', () => {
  it('returns true when applicableRegions is empty / undefined (region-agnostic)', () => {
    expect(RegionResolver.appliesTo('us-east-1', undefined)).toBe(true);
    expect(RegionResolver.appliesTo('us-east-1', [])).toBe(true);
  });

  it('matches concrete region', () => {
    expect(RegionResolver.appliesTo('us-east-1', ['us-east-1'])).toBe(true);
    expect(RegionResolver.appliesTo('us-east-1', ['eu-west-1'])).toBe(false);
  });

  it('matches glob region', () => {
    expect(RegionResolver.appliesTo('us-east-1', ['us-*'])).toBe(true);
    expect(RegionResolver.appliesTo('eu-central-1', ['us-*'])).toBe(false);
    expect(RegionResolver.appliesTo('eu-central-1', ['eu-*', 'us-*'])).toBe(true);
  });

  it('matches the neutral marker for any tenant', () => {
    expect(RegionResolver.appliesTo('us-east-1', ['*'])).toBe(true);
    expect(RegionResolver.appliesTo('eu-west-1', ['*'])).toBe(true);
    expect(RegionResolver.appliesTo(null, ['*'])).toBe(true);
  });

  it('null tenant region only matches the neutral marker', () => {
    expect(RegionResolver.appliesTo(null, ['us-*'])).toBe(false);
    expect(RegionResolver.appliesTo(null, ['*'])).toBe(true);
  });
});
