/**
 * K.5 — hybrid ranking v1 unit suite. Pure signal fusion: lexical + vector +
 * recency + source-authority, with graph proximity accepted additively (K.8).
 */
import { describe, it, expect } from '@jest/globals';
import { hybridRank, DEFAULT_HYBRID_WEIGHTS, type RankInput } from '../hybridRank.js';

const now = 1_000_000_000_000;

function cand(id: string, o: Partial<RankInput> = {}): RankInput {
  return { candidateId: id, lexical: 0, vector: 0, updatedAtMs: now, source: 's', ...o };
}

describe('hybridRank — signal fusion', () => {
  it('ranks a strong vector hit above a weak one when lexical ties', () => {
    const ranked = hybridRank(
      [cand('a', { vector: 0.9 }), cand('b', { vector: 0.2 })],
      { nowMs: now },
    );
    expect(ranked.map((r) => r.candidateId)).toEqual(['a', 'b']);
  });

  it('lexical scores are min-max normalized within the set', () => {
    const ranked = hybridRank(
      [cand('a', { lexical: 10 }), cand('b', { lexical: 5 })],
      { nowMs: now },
    );
    // a's lexical normalizes to 1.0, b's to 0.5 → a wins, and the top score
    // is a convex combination in [0,1].
    expect(ranked[0]!.candidateId).toBe('a');
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked[0]!.score).toBeLessThanOrEqual(1);
  });

  it('recency decays an old candidate below a fresh equal one', () => {
    const ranked = hybridRank(
      [
        cand('fresh', { vector: 0.5, updatedAtMs: now }),
        cand('old', { vector: 0.5, updatedAtMs: now - 60 * 86_400_000 }), // 60 days
      ],
      { nowMs: now },
    );
    expect(ranked.map((r) => r.candidateId)).toEqual(['fresh', 'old']);
  });

  it('source authority breaks a tie', () => {
    const ranked = hybridRank(
      [cand('a', { vector: 0.5, source: 'authoritative' }), cand('b', { vector: 0.5, source: 'weak' })],
      { nowMs: now, sourceAuthority: { authoritative: 1.0, weak: 0.1 } },
    );
    expect(ranked[0]!.candidateId).toBe('a');
  });

  it('graph proximity is additive and OFF by default (weight 0)', () => {
    // With the default weights, graphProximity contributes nothing — two
    // candidates identical but for graphProximity tie.
    const ranked = hybridRank(
      [cand('a', { vector: 0.5, graphProximity: 1 }), cand('b', { vector: 0.5, graphProximity: 0 })],
      { nowMs: now },
    );
    expect(ranked[0]!.score).toBeCloseTo(ranked[1]!.score, 10);
    // Turning the weight on (K.8) makes it matter, without touching the others.
    const k8 = hybridRank(
      [cand('a', { vector: 0.5, graphProximity: 1 }), cand('b', { vector: 0.5, graphProximity: 0 })],
      { nowMs: now, weights: { ...DEFAULT_HYBRID_WEIGHTS, graphProximity: 0.5 } },
    );
    expect(k8[0]!.candidateId).toBe('a');
    expect(k8[0]!.score).toBeGreaterThan(k8[1]!.score);
  });

  it('exposes the per-signal breakdown for auditability', () => {
    const [r] = hybridRank([cand('a', { lexical: 4, vector: 0.6 })], { nowMs: now });
    expect(r!.signals.lexical).toBe(1); // sole candidate → normalizes to 1
    expect(r!.signals.vector).toBe(0.6);
    expect(r!.signals.recency).toBeCloseTo(1, 5);
    expect(r!.signals.sourceAuthority).toBe(0.5); // unknown source default
  });
});
