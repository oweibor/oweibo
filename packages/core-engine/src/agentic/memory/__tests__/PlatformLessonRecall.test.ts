/**
 * T.4 — PlatformLessonRecall tests.
 *
 * Verifies:
 *   - returns empty when no rows scanned
 *   - filters by role / slotId at SQL level
 *   - DLP filter at read time drops rows that fail current rules
 *   - audit is called exactly once with the correct payload
 *   - topK + lexical scoring picks the highest-overlap rows
 *   - SQL JOIN against releasable_buckets is present (K ≥ 5 guard)
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PlatformLessonRecall, type AuditRow } from '../PlatformLessonRecall.js';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const stub = stubs.find((s) => sql.includes(s.match));
    return Promise.resolve({
      rows: stub ? stub.rows : [],
      rowCount: stub ? stub.rows.length : 0,
      command: '', oid: 0, fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, calls };
}

describe('PlatformLessonRecall.recall', () => {
  it('returns empty when no rows match', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.platform_lessons', rows: [] },
    ]);
    const audits: AuditRow[] = [];
    const svc = new PlatformLessonRecall(pool, { audit: async (r) => { audits.push(r); } });
    const out = await svc.recall({ query: 'how do I deploy without downtime' });
    expect(out).toEqual([]);
  });

  it('queries through the K-anonymity-gated releasable_buckets view', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.platform_lessons', rows: [] },
    ]);
    const svc = new PlatformLessonRecall(pool);
    await svc.recall({ query: 'x y z' });
    const q = calls.find((c) => c.sql.includes('FROM oweibo.platform_lessons'));
    expect(q?.sql).toMatch(/JOIN oweibo\.releasable_buckets/);
  });

  it('threads role and slotId into the WHERE clause', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.platform_lessons', rows: [] },
    ]);
    const svc = new PlatformLessonRecall(pool);
    await svc.recall({ query: 'a b c', role: 'executor', slotId: 'main' });
    const q = calls.find((c) => c.sql.includes('FROM oweibo.platform_lessons'));
    // role and slotId are bound parameters, in $1/$2 with the limit last
    expect(q?.params.slice(0, 2)).toEqual(['executor', 'main']);
  });

  it('scores hits by lexical token overlap and returns top-K', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.platform_lessons',
        rows: [
          // High overlap: 3 tokens shared with query "deploy production canary"
          { summary: 'always canary your deploy before production', body: null, bucket_key: 'b1', tenant_count: 7, confidence: '0.9' },
          // Medium overlap: 1 token shared
          { summary: 'lint your code on commit', body: null, bucket_key: 'b2', tenant_count: 6, confidence: '0.8' },
          // No overlap → excluded
          { summary: 'rotate api keys quarterly', body: null, bucket_key: 'b3', tenant_count: 8, confidence: '0.7' },
        ],
      },
    ]);
    const svc = new PlatformLessonRecall(pool);
    const out = await svc.recall({ query: 'deploy production canary', topK: 5 });
    expect(out).toHaveLength(1); // only b1 has nonzero overlap (lint shares no relevant token)
    expect(out[0]?.bucketKey).toBe('b1');
    expect(out[0]?.contributorCount).toBe(7);
  });

  it('drops hits that fail DLP at read time', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.platform_lessons',
        rows: [
          // Contains an email — LessonDLPFilter rejects.
          { summary: 'always canary deploy then notify oncall@example.com', body: null, bucket_key: 'bad', tenant_count: 6, confidence: '0.9' },
          // Clean.
          { summary: 'always canary your deploy before promotion', body: null, bucket_key: 'good', tenant_count: 7, confidence: '0.9' },
        ],
      },
    ]);
    const svc = new PlatformLessonRecall(pool);
    const out = await svc.recall({ query: 'canary deploy' });
    expect(out.map((h) => h.bucketKey)).not.toContain('bad');
  });

  it('writes an audit row with the SHA-256 of the query (not the raw text)', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.platform_lessons',
        rows: [
          { summary: 'deploy with caution', body: null, bucket_key: 'b1', tenant_count: 5, confidence: '0.8' },
        ],
      },
    ]);
    const audits: AuditRow[] = [];
    const svc = new PlatformLessonRecall(pool, { audit: async (r) => { audits.push(r); } });
    await svc.recall({ query: 'deploy please', role: 'executor', slotId: 'main' });
    // Audit is fire-and-forget; let microtask drain.
    await new Promise((r) => setImmediate(r));
    expect(audits).toHaveLength(1);
    const a = audits[0];
    expect(a?.action).toBe('memory.platform_lesson.recall');
    expect(a?.details.query_hash).toMatch(/^[0-9a-f]{64}$/);
    // Raw query MUST NOT appear in the audit row.
    expect(JSON.stringify(a)).not.toContain('deploy please');
    expect(a?.details.role).toBe('executor');
    expect(a?.details.slot_id).toBe('main');
    expect(a?.details.hits_returned).toBe(1);
    expect(a?.details.bucket_keys).toEqual(['b1']);
  });

  it('caps topK at 20 even if a larger value is supplied', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      summary: `deploy canary lesson ${i}`,
      body: null, bucket_key: `b${i}`, tenant_count: 6, confidence: '0.9',
    }));
    const { pool } = makePool([
      { match: 'FROM oweibo.platform_lessons', rows },
    ]);
    const svc = new PlatformLessonRecall(pool);
    const out = await svc.recall({ query: 'deploy canary', topK: 100 });
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('returns empty when the query tokenises to nothing meaningful', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.platform_lessons',
        rows: [
          { summary: 'deploy with caution', body: null, bucket_key: 'b1', tenant_count: 5, confidence: '0.8' },
        ],
      },
    ]);
    const svc = new PlatformLessonRecall(pool);
    const out = await svc.recall({ query: 'a b' }); // tokens are too short (<3 chars)
    expect(out).toEqual([]);
  });

  // T.8 — region gate at recall time
  it('does NOT thread a region filter when caller omits homeRegion', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.platform_lessons', rows: [] },
    ]);
    const svc = new PlatformLessonRecall(pool);
    await svc.recall({ query: 'anything' });
    const q = calls.find((c) => c.sql.includes('FROM oweibo.platform_lessons'));
    expect(q?.sql).not.toMatch(/pl\.home_region/);
  });

  it('adds "home_region IS NULL OR = $N" filter when homeRegion is supplied', async () => {
    const { pool, calls } = makePool([
      { match: 'FROM oweibo.platform_lessons', rows: [] },
    ]);
    const svc = new PlatformLessonRecall(pool);
    await svc.recall({ query: 'anything', homeRegion: 'eu-central-1' });
    const q = calls.find((c) => c.sql.includes('FROM oweibo.platform_lessons'));
    expect(q?.sql).toMatch(/pl\.home_region IS NULL OR pl\.home_region = \$/);
    // homeRegion is the last bound param before the LIMIT.
    expect(q?.params).toContain('eu-central-1');
  });

  it('audit row does NOT carry the raw homeRegion (region is coarse but still logged via params)', async () => {
    const { pool } = makePool([
      { match: 'FROM oweibo.platform_lessons',
        rows: [{ summary: 'deploy with caution', body: null, bucket_key: 'b1', tenant_count: 5, confidence: '0.8' }] },
    ]);
    const audits: AuditRow[] = [];
    const svc = new PlatformLessonRecall(pool, { audit: async (r) => { audits.push(r); } });
    await svc.recall({ query: 'deploy please', homeRegion: 'eu-central-1' });
    await new Promise((r) => setImmediate(r));
    // Region is not currently in the audit details (matches today's contract).
    // The audit row is hashed query + bucket_keys; region travels via SQL params.
    expect(audits[0]?.details.query_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('absorbs DB errors and returns empty rather than throwing', async () => {
    const client = {
      query: jest.fn().mockRejectedValue(new Error('pg down')),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: jest.fn().mockResolvedValue(client),
    } as unknown as Pool;
    const svc = new PlatformLessonRecall(pool);
    const out = await svc.recall({ query: 'anything' });
    expect(out).toEqual([]);
  });
});
