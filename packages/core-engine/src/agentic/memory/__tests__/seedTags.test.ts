/**
 * T.2.a — shared seed-tag predicates. Imported by MemoryDecayService,
 * MemoryConsolidator, and MemoryWarmer to keep the seed-recognition logic
 * consistent. These tests pin the contract for all three sites.
 */
import { isSeedTagged, isSuppressedSeedTagged } from '../seedTags.js';

describe('isSeedTagged', () => {
  it('false for undefined tags', () => {
    expect(isSeedTagged(undefined)).toBe(false);
  });
  it('false for empty tags', () => {
    expect(isSeedTagged([])).toBe(false);
  });
  it('false for organic tag list', () => {
    expect(isSeedTagged(['language:typescript', 'topic:auth'])).toBe(false);
  });
  it('true when a seed:<id> tag is present', () => {
    expect(isSeedTagged(['scope:starter', 'seed:abc'])).toBe(true);
  });
  it('true when a seed:catalog:<version> tag is present (no other seed: tag)', () => {
    expect(isSeedTagged(['seed:catalog:1'])).toBe(true);
  });
  it('true when a seed:suppressed:<reason> tag is present', () => {
    expect(isSeedTagged(['seed:suppressed:thumbs_down_floor'])).toBe(true);
  });
  it('ignores non-string tag values defensively', () => {
    // Qdrant payloads occasionally include nulls if a writer mis-shapes the row.
    expect(isSeedTagged([null as unknown as string, 'organic'])).toBe(false);
  });
});

describe('isSuppressedSeedTagged', () => {
  it('false for plain seed entry', () => {
    expect(isSuppressedSeedTagged(['seed:abc', 'seed:catalog:1'])).toBe(false);
  });
  it('true when seed:suppressed:* tag is present', () => {
    expect(isSuppressedSeedTagged(['seed:abc', 'seed:suppressed:thumbs_down_floor'])).toBe(true);
  });
  it('false when only a non-prefix substring matches', () => {
    expect(isSuppressedSeedTagged(['suppressed:thing'])).toBe(false);
  });
  it('false for undefined tags', () => {
    expect(isSuppressedSeedTagged(undefined)).toBe(false);
  });
});
