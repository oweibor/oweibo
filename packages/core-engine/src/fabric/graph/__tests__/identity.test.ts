/**
 * ADR-002 §7 conformance suite — identity scoring + graph traversal, pure.
 * Max-rule confidence, three states + auto-merge bar, hedged Provisional,
 * cycle-safe traversal, and graph proximity over active edges only.
 */
import { describe, it, expect } from '@jest/globals';
import {
  scoreIdentity,
  identityState,
  graphExpansion,
  autoMerges,
  hedgeResponse,
  IDENTITY_SIGNAL_WEIGHTS,
  type IdentitySignal,
} from '../identityScoring.js';
import {
  traverse,
  shortestPathLen,
  graphProximity,
  neighborsByType,
  type GraphEdge,
} from '../graphTraversal.js';

describe('ADR-002 §3.2 — confidence is the strongest signal (max, never sum)', () => {
  it('a single employee-id match resolves (1.0)', () => {
    expect(scoreIdentity(['employee_id'])).toBe(1.0);
  });
  it('name-only alone never resolves (0.30)', () => {
    expect(scoreIdentity(['name_only'])).toBe(0.3);
  });
  it('correlated signals do NOT sum past the strongest', () => {
    // email 0.98 + oauth 0.95 must stay 0.98, not 1.93.
    expect(scoreIdentity(['corporate_email', 'oauth_subject'])).toBe(0.98);
  });
  it('empty signals → 0', () => {
    expect(scoreIdentity([])).toBe(0);
  });
  it('uses the §9.1 table verbatim', () => {
    const all: IdentitySignal[] = ['employee_id', 'corporate_email', 'idp_principal_id', 'oauth_subject', 'name_and_manager', 'name_only'];
    for (const s of all) expect(IDENTITY_SIGNAL_WEIGHTS[s]).toBeGreaterThan(0);
  });
});

describe('ADR-002 §3.3 — three states + the auto-merge bar', () => {
  it('>0.95 resolved, 0.70–0.95 provisional, <0.70 unresolved', () => {
    expect(identityState(1.0)).toBe('resolved');
    expect(identityState(0.98)).toBe('resolved');
    expect(identityState(0.95)).toBe('provisional'); // boundary: 0.95 is NOT > 0.95
    expect(identityState(0.8)).toBe('provisional');
    expect(identityState(0.7)).toBe('provisional');
    expect(identityState(0.69)).toBe('unresolved');
    expect(identityState(0.3)).toBe('unresolved');
  });
  it('only Resolved auto-merges', () => {
    expect(autoMerges('resolved')).toBe(true);
    expect(autoMerges('provisional')).toBe(false);
    expect(autoMerges('unresolved')).toBe(false);
  });
  it('graph expansion policy per state', () => {
    expect(graphExpansion('resolved')).toBe('full');
    expect(graphExpansion('provisional')).toBe('conservative');
    expect(graphExpansion('unresolved')).toBe('none');
  });
});

describe('ADR-002 §3.4 — hedged language', () => {
  it('resolved asserts directly', () => {
    expect(hedgeResponse('resolved', 'Bob', 'owns', 'Project Atlas')).toBe('Bob owns Project Atlas');
  });
  it('provisional is ALWAYS hedged', () => {
    expect(hedgeResponse('provisional', 'Bob', 'associated with', 'Project Atlas'))
      .toBe('Based on available identity mappings, Bob is likely associated with Project Atlas.');
  });
  it('unresolved makes no assertion', () => {
    expect(hedgeResponse('unresolved', 'Bob', 'owns', 'Atlas')).toBeNull();
  });
});

describe('ADR-002 §3.6 — traversal (cycle-safe, active-only)', () => {
  const edge = (srcRef: string, dstRef: string, over: Partial<GraphEdge> = {}): GraphEdge =>
    ({ srcRef, dstRef, edgeType: 'rel', state: 'active', confidence: 'resolved', ...over });

  it('reaches transitively and records shortest distance', () => {
    const g = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    const { distances } = traverse(g, 'a');
    expect(distances.get('d')).toBe(3);
  });

  it('is cycle-safe', () => {
    const g = [edge('a', 'b'), edge('b', 'a'), edge('b', 'c')];
    const { distances } = traverse(g, 'a');
    expect(distances.get('c')).toBe(2);
  });

  it('never traverses pending or retracted edges', () => {
    const g = [edge('a', 'b', { state: 'pending' }), edge('a', 'c', { state: 'retracted' }), edge('a', 'd')];
    const { distances } = traverse(g, 'a');
    expect(distances.has('b')).toBe(false);
    expect(distances.has('c')).toBe(false);
    expect(distances.get('d')).toBe(1);
  });

  it('respects the depth bound and flags truncation', () => {
    const g = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    const res = traverse(g, 'a', 1);
    expect(res.distances.get('b')).toBe(1);
    expect(res.distances.has('c')).toBe(false);
    expect(res.truncated).toBe(true);
  });
});

describe('ADR-002 §3.6 — graph proximity (active edges only)', () => {
  const edge = (srcRef: string, dstRef: string, over: Partial<GraphEdge> = {}): GraphEdge =>
    ({ srcRef, dstRef, edgeType: 'rel', state: 'active', confidence: 'resolved', ...over });

  it('self=1, adjacent=0.5, two hops≈0.33, unreachable=0', () => {
    const g = [edge('a', 'b'), edge('b', 'c')];
    expect(graphProximity(g, 'a', 'a')).toBe(1);
    expect(graphProximity(g, 'a', 'b')).toBe(0.5);
    expect(graphProximity(g, 'a', 'c')).toBeCloseTo(1 / 3, 5);
    expect(graphProximity(g, 'a', 'z')).toBe(0);
  });

  it('a retracted merge stops boosting proximity immediately', () => {
    const active = [edge('bob', 'atlas')];
    expect(graphProximity(active, 'bob', 'atlas')).toBe(0.5);
    const retracted = [edge('bob', 'atlas', { state: 'retracted' })];
    expect(graphProximity(retracted, 'bob', 'atlas')).toBe(0); // no longer reachable
  });

  it('shortestPathLen null when unreachable', () => {
    expect(shortestPathLen([edge('a', 'b')], 'a', 'z')).toBeNull();
  });

  it('neighborsByType finds owners (in-edges of an owns relation)', () => {
    const g = [
      edge('bob', 'atlas', { edgeType: 'owns' }),
      edge('alice', 'atlas', { edgeType: 'reviews' }),
    ];
    expect(neighborsByType(g, 'atlas', 'owns', 'in')).toEqual(['bob']);
  });
});
