/**
 * ADR-010 §3.3/§3.4 conformance — evaluation-time closure over raw edges:
 * nesting, cycles, depth truncation, and the audience predicate.
 */
import { computeGroupClosure, isInAudience, DEFAULT_CLOSURE_DEPTH } from '../groupClosure.js';
import type { MembershipEdge } from '../groupClosure.js';

const edge = (principalRef: string, groupRef: string): MembershipEdge => ({ principalRef, groupRef });

describe('computeGroupClosure', () => {
  it('direct + nested memberships (groups appear as principals — raw-edge nesting)', () => {
    const edges = [
      edge('u-ada', 'g-eng'),
      edge('g-eng', 'g-all-staff'),
      edge('g-all-staff', 'g-everyone'),
      edge('u-bob', 'g-sales'),
    ];
    const r = computeGroupClosure(edges, 'u-ada');
    expect([...r.groups].sort()).toEqual(['g-all-staff', 'g-eng', 'g-everyone']);
    expect(r.truncated).toBe(false);
  });

  it('tolerates cycles in directory data without looping', () => {
    const edges = [
      edge('u-ada', 'g-a'),
      edge('g-a', 'g-b'),
      edge('g-b', 'g-a'),   // cycle
    ];
    const r = computeGroupClosure(edges, 'u-ada');
    expect([...r.groups].sort()).toEqual(['g-a', 'g-b']);
    expect(r.truncated).toBe(false);
  });

  it('diamond nesting counts each group once', () => {
    const edges = [
      edge('u-ada', 'g-left'),
      edge('u-ada', 'g-right'),
      edge('g-left', 'g-top'),
      edge('g-right', 'g-top'),
    ];
    const r = computeGroupClosure(edges, 'u-ada');
    expect([...r.groups].sort()).toEqual(['g-left', 'g-right', 'g-top']);
  });

  it('reports truncation at the depth bound instead of erroring or silently narrowing', () => {
    // Chain u → g1 → g2 → ... → g25 with maxDepth 20.
    const edges: MembershipEdge[] = [edge('u', 'g1')];
    for (let i = 1; i < 25; i++) edges.push(edge(`g${i}`, `g${i + 1}`));
    const r = computeGroupClosure(edges, 'u', { maxDepth: 20 });
    expect(r.truncated).toBe(true);
    expect(r.groups.has('g20')).toBe(true);
    expect(r.groups.has('g21')).toBe(false);  // beyond the bound — hence truncated
    // Default bound is the §6 value.
    expect(DEFAULT_CLOSURE_DEPTH).toBe(20);
  });

  it('a chain that ends exactly at the bound is complete, not truncated', () => {
    const edges: MembershipEdge[] = [edge('u', 'g1')];
    for (let i = 1; i < 20; i++) edges.push(edge(`g${i}`, `g${i + 1}`));
    const r = computeGroupClosure(edges, 'u', { maxDepth: 20 });
    expect(r.groups.size).toBe(20);
    expect(r.truncated).toBe(false);
  });

  it('unknown principal yields an empty, non-truncated closure', () => {
    const r = computeGroupClosure([edge('u-ada', 'g-eng')], 'u-nobody');
    expect(r.groups.size).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

describe('isInAudience (§3.4, within-source)', () => {
  const edges = [edge('u-ada', 'g-eng'), edge('g-eng', 'g-all')];

  it('matches direct principal grants', () => {
    const closure = computeGroupClosure(edges, 'u-ada');
    expect(isInAudience(['u-ada'], 'u-ada', closure)).toBe(true);
  });

  it('matches via transitive group membership', () => {
    const closure = computeGroupClosure(edges, 'u-ada');
    expect(isInAudience(new Set(['g-all']), 'u-ada', closure)).toBe(true);
  });

  it('excludes principals outside the audience', () => {
    const closure = computeGroupClosure(edges, 'u-bob');
    expect(isInAudience(['u-ada', 'g-eng'], 'u-bob', closure)).toBe(false);
  });
});
