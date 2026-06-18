/**
 * D.5 — SmeReviewService tests (mock pg pool, longest-match SQL stubs).
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { SmeReviewService } from '../SmeReviewService.js';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    // Longest-match wins so 'INSERT INTO oweibo.sme_reviews' beats 'INSERT'.
    const matching = stubs.filter((s) => sql.includes(s.match)).sort((a, b) => b.match.length - a.match.length);
    const stub = matching[0];
    return Promise.resolve({
      rows: stub ? stub.rows : [],
      rowCount: stub ? stub.rows.length : 0,
      command: '',
      oid: 0,
      fields: [],
    });
  };
  const client = {
    query: jest.fn().mockImplementation(queryFn),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

describe('SmeReviewService.enqueueSample', () => {
  it('inserts a queue row and returns its id', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.sme_review_queue', rows: [{ id: 'q-1' }] },
    ]);
    const svc = new SmeReviewService(pool);
    const id = await svc.enqueueSample({
      domainSlug: 'fintech',
      tenantId: '00000000-0000-0000-0000-00000000000a',
      artifactKind: 'task_output',
      artifactRef: { taskId: 't-1' },
      anonymizedPayload: { summary: '[redacted]' },
    });
    expect(id).toBe('q-1');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.sme_review_queue'));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain('fintech');
    expect(insert!.params).toContain('task_output');
  });

  it('defaults requiredReviews to 2 when omitted', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.sme_review_queue', rows: [{ id: 'q-1' }] },
    ]);
    const svc = new SmeReviewService(pool);
    await svc.enqueueSample({
      domainSlug: 'fintech',
      tenantId: '00000000-0000-0000-0000-00000000000a',
      artifactKind: 'task_output',
      artifactRef: {},
      anonymizedPayload: {},
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.sme_review_queue'));
    expect(insert!.params).toContain(2);
  });
});

describe('SmeReviewService.submitReview', () => {
  it('inserts a review and transitions pending → assigned on first submission', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.sme_reviews', rows: [{ id: 'r-1' }] },
      // count(*) result + required_reviews + state
      { match: '(SELECT COUNT(*)', rows: [{ n: '1', required: 2, state: 'pending' }] },
      { match: "SET state = 'assigned'", rows: [] },
    ]);
    const svc = new SmeReviewService(pool);
    const id = await svc.submitReview({
      queueItemId: 'q-1',
      reviewerId: '00000000-0000-0000-0000-00000000000b',
      overallVerdict: 'correct',
    });
    expect(id).toBe('r-1');
    const transitionsToAssigned = calls.some(
      (c) => c.sql.includes("SET state = 'assigned'") && c.params.includes('q-1'),
    );
    expect(transitionsToAssigned).toBe(true);
  });

  it("transitions to 'reviewed' once required_reviews threshold crossed", async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.sme_reviews', rows: [{ id: 'r-2' }] },
      { match: '(SELECT COUNT(*)', rows: [{ n: '2', required: 2, state: 'assigned' }] },
      { match: "SET state = 'reviewed'", rows: [] },
    ]);
    const svc = new SmeReviewService(pool);
    await svc.submitReview({
      queueItemId: 'q-1',
      reviewerId: '00000000-0000-0000-0000-00000000000b',
      overallVerdict: 'partially_correct',
      ontologySuggestions: [
        { targetKind: 'ontology_glossary', targetId: 'EOD', suggestedChange: { definition: 'end of day' } },
      ],
    });
    expect(calls.some((c) => c.sql.includes("SET state = 'reviewed'"))).toBe(true);
  });

  it('rolls back when the insert raises (UNIQUE conflict surfaces as throw)', async () => {
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      if (sql.includes('INSERT INTO oweibo.sme_reviews')) {
        return Promise.reject(new Error('duplicate'));
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const calls: string[] = [];
    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        calls.push(sql);
        return queryFn(sql);
      }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const svc = new SmeReviewService(pool);
    await expect(
      svc.submitReview({
        queueItemId: 'q-1',
        reviewerId: '00000000-0000-0000-0000-00000000000b',
        overallVerdict: 'correct',
      }),
    ).rejects.toThrow(/duplicate/);
    expect(calls.some((s) => s === 'ROLLBACK')).toBe(true);
  });
});

describe('SmeReviewService.listQueueForReviewer', () => {
  it('returns mapped queue items', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.sme_review_queue',
        rows: [
          {
            id: 'q-1',
            domain_slug: 'fintech',
            tenant_id: '00000000-0000-0000-0000-00000000000a',
            task_id: null,
            artifact_kind: 'task_output',
            artifact_ref: { taskId: 't-1' },
            anonymized_payload: {},
            state: 'pending',
            required_reviews: 2,
            sampled_at: new Date('2026-05-28T00:00:00Z'),
            closed_at: null,
          },
        ],
      },
    ]);
    const svc = new SmeReviewService(pool);
    const items = await svc.listQueueForReviewer({
      reviewerId: '00000000-0000-0000-0000-00000000000b',
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('q-1');
    expect(items[0]!.sampledAt).toBe('2026-05-28T00:00:00.000Z');
  });
});

describe('SmeReviewService.markAggregated / closeQueueItem', () => {
  it('markAggregated transitions reviewed → aggregated', async () => {
    const { pool, calls } = makePool([
      { match: "SET state = 'aggregated'", rows: [] },
    ]);
    const svc = new SmeReviewService(pool);
    await svc.markAggregated('q-1');
    expect(calls.some((c) => c.sql.includes("SET state = 'aggregated'"))).toBe(true);
  });

  it('closeQueueItem transitions to closed with closed_at', async () => {
    const { pool, calls } = makePool([
      { match: "SET state = 'closed'", rows: [] },
    ]);
    const svc = new SmeReviewService(pool, { now: () => new Date('2026-06-01T00:00:00Z') });
    await svc.closeQueueItem('q-1');
    const close = calls.find((c) => c.sql.includes("SET state = 'closed'"));
    expect(close).toBeDefined();
    expect(close!.params[0]).toBe('q-1');
  });
});
