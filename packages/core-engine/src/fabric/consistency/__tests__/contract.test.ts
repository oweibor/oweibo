/**
 * ADR-003 conformance — every §3.1 comparison row, monotonic-merge
 * refusal (INV-7), conflict classes, chunk-diff, pending edges, recall
 * acceptance, and the published guarantee tables.
 */
import {
  compareRevisions,
  gapRange,
  mergeRevisionVector,
  classifyConflict,
  chunksToReindex,
  decidePendingEdge,
  PENDING_EDGE_EXPIRY_MS,
  evaluateRecallDelta,
  CONSISTENCY_GUARANTEES,
  SOURCE_OF_TRUTH,
} from '../contract.js';

describe('compareRevisions (§3.1 / INV-6)', () => {
  it('covers every table row', () => {
    expect(compareRevisions(1, undefined)).toBe('process');       // first sighting
    expect(compareRevisions(5, undefined)).toBe('process_gap');   // first sighting w/ history
    expect(compareRevisions(3, 3)).toBe('ignore');                // duplicate
    expect(compareRevisions(2, 3)).toBe('ignore');                // out-of-order
    expect(compareRevisions(4, 3)).toBe('process');               // the normal path
    expect(compareRevisions(7, 3)).toBe('process_gap');           // gap
  });

  it('rejects non-positive / non-integer revisions loudly', () => {
    expect(() => compareRevisions(0, undefined)).toThrow(/positive integers/);
    expect(() => compareRevisions(1.5, 1)).toThrow(/positive integers/);
  });

  it('gapRange owes backfill exactly for the missing middle', () => {
    expect(gapRange(7, 3)).toEqual({ from: 4, to: 6 });
    expect(gapRange(5, undefined)).toEqual({ from: 1, to: 4 });
    expect(gapRange(4, 3)).toBeNull();
    expect(gapRange(1, undefined)).toBeNull();
  });
});

describe('mergeRevisionVector (§3.2 / INV-7)', () => {
  const base = { revisions: { google_drive: 183, confluence: 71 }, indexGeneration: 62 };

  it('advances the source entry and bumps index_generation by exactly 1', () => {
    const r = mergeRevisionVector({ ...base, source: 'google_drive', incomingRevision: 184 });
    expect(r).toEqual({
      ok: true,
      revisions: { google_drive: 184, confluence: 71 },
      indexGeneration: 63,
    });
  });

  it('adds a new contributing source without touching others', () => {
    const r = mergeRevisionVector({ ...base, source: 'sharepoint', incomingRevision: 15 });
    expect(r.ok && r.revisions).toEqual({ google_drive: 183, confluence: 71, sharepoint: 15 });
  });

  it('REFUSES a decrease — defect signal, never a rollback', () => {
    const r = mergeRevisionVector({ ...base, source: 'google_drive', incomingRevision: 180 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violation).toMatch(/monotonicity violation.*183 → 180/);
  });

  it('equal re-apply is permitted (idempotent replay lands the same value)', () => {
    const r = mergeRevisionVector({ ...base, source: 'confluence', incomingRevision: 71 });
    expect(r.ok).toBe(true);
  });
});

describe('classifyConflict (§3.3)', () => {
  it('equal = consistent; live ahead = index_stale (the §16.2 chain); live behind = breach', () => {
    expect(classifyConflict(52, 52)).toBe('consistent');
    expect(classifyConflict(52, 49)).toBe('index_stale');
    expect(classifyConflict(49, 52)).toBe('monotonicity_breach');
  });
});

describe('chunksToReindex (§3.5)', () => {
  const stored = [
    { fieldName: 'body', spanStart: 0, spanEnd: 100, chunkHash: 'h1' },
    { fieldName: 'body', spanStart: 100, spanEnd: 200, chunkHash: 'h2' },
    { fieldName: 'title', spanStart: 0, spanEnd: 20, chunkHash: 'h3' },
  ];

  it('re-embeds only changed chunks; deletes vanished ones; keeps identical ones', () => {
    const incoming = [
      { fieldName: 'body', spanStart: 0, spanEnd: 100, chunkHash: 'h1' },      // unchanged
      { fieldName: 'body', spanStart: 100, spanEnd: 200, chunkHash: 'h2b' },   // changed
      { fieldName: 'comments', spanStart: 0, spanEnd: 50, chunkHash: 'h4' },   // new
      // title chunk absent → delete
    ];
    const diff = chunksToReindex(stored, incoming);
    expect(diff.unchanged.map((c) => c.chunkHash)).toEqual(['h1']);
    expect(diff.toUpsert.map((c) => c.chunkHash).sort()).toEqual(['h2b', 'h4']);
    expect(diff.toDelete.map((c) => c.chunkHash)).toEqual(['h3']);
  });

  it('an unchanged document re-embeds NOTHING (the defect §3.5 exists to prevent)', () => {
    const diff = chunksToReindex(stored, stored);
    expect(diff.toUpsert).toEqual([]);
    expect(diff.toDelete).toEqual([]);
    expect(diff.unchanged).toHaveLength(3);
  });
});

describe('decidePendingEdge (§3.6)', () => {
  it('activates on referent arrival, holds within expiry, expires beyond it', () => {
    expect(decidePendingEdge({ referentExists: true, heldForMs: 0 })).toBe('activate');
    expect(decidePendingEdge({ referentExists: true, heldForMs: PENDING_EDGE_EXPIRY_MS * 2 }))
      .toBe('activate');  // late referent still wins over expiry
    expect(decidePendingEdge({ referentExists: false, heldForMs: 1000 })).toBe('hold');
    expect(decidePendingEdge({ referentExists: false, heldForMs: PENDING_EDGE_EXPIRY_MS }))
      .toBe('expire');
  });
});

describe('evaluateRecallDelta (§3.8)', () => {
  it('accepts < 1% regression, rejects ≥ 1%, and improvement is always accepted', () => {
    expect(evaluateRecallDelta(0.90, 0.895).accepted).toBe(true);   // 0.5% down
    expect(evaluateRecallDelta(0.90, 0.89).accepted).toBe(false);   // exactly 1% down
    expect(evaluateRecallDelta(0.90, 0.85).accepted).toBe(false);
    expect(evaluateRecallDelta(0.90, 0.95).accepted).toBe(true);
    expect(() => evaluateRecallDelta(1.2, 0.5)).toThrow(/\[0,1\]/);
  });
});

describe('published guarantee tables (§3.7)', () => {
  it('mirror arch §15 / §16.1 exactly where it matters', () => {
    expect(CONSISTENCY_GUARANTEES['acl_write_ops']).toBe('strong');
    expect(CONSISTENCY_GUARANTEES['search_index']).toBe('eventual');
    expect(CONSISTENCY_GUARANTEES['permission_cache']).toBe('strong_critical_eventual_rest');
    expect(SOURCE_OF_TRUTH['permissions']).toBe('live');
    expect(SOURCE_OF_TRUTH['tool_actions']).toBe('live');
    expect(SOURCE_OF_TRUTH['document_body']).toBe('indexed');
    expect(SOURCE_OF_TRUTH['metadata']).toBe('highest_revision');
  });
});
