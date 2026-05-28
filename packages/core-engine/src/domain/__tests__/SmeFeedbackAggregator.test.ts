/**
 * D.5 — SmeFeedbackAggregator tests.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { SmeReview } from '@oweibo/core-contracts';
import {
  SmeFeedbackAggregator,
  groupSuggestions,
} from '../SmeFeedbackAggregator.js';

function review(
  reviewerId: string,
  overrides: Partial<SmeReview> = {},
): SmeReview {
  return {
    id: `rev-${reviewerId}`,
    queueItemId: 'q-1',
    reviewerId,
    overallVerdict: 'correct',
    perCriterion: [],
    ontologySuggestions: [],
    rubricSuggestions: [],
    ruleSuggestions: [],
    comment: null,
    reviewedAt: '2026-05-28T00:00:00Z',
    ...overrides,
  };
}

function makePool(): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return Promise.resolve({
        rows: [],
        rowCount: 0,
        command: '',
        oid: 0,
        fields: [],
      } as QueryResult<QueryResultRow>);
    }),
    release: jest.fn(),
  } as unknown as PoolClient;
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

describe('groupSuggestions', () => {
  it('buckets suggestions by (targetKind, targetId) across reviewers', () => {
    const reviews = [
      review('a', {
        ontologySuggestions: [
          { targetKind: 'ontology_glossary', targetId: 'EOD', suggestedChange: { def: 'end-of-day' } },
        ],
      }),
      review('b', {
        ontologySuggestions: [
          { targetKind: 'ontology_glossary', targetId: 'EOD', suggestedChange: { def: 'end-of-day' } },
        ],
      }),
      review('c', {
        ontologySuggestions: [
          { targetKind: 'ontology_glossary', targetId: 'EOD', suggestedChange: { def: 'end of discussion' } },
        ],
      }),
    ];
    const g = groupSuggestions(reviews);
    expect(g.size).toBe(1);
    const bucket = [...g.values()][0]!;
    expect(bucket.reviewerIds.size).toBe(3);
    expect(bucket.byChange.size).toBe(2);
  });

  it('canonicalises object suggestions (key order does not split buckets)', () => {
    const reviews = [
      review('a', {
        rubricSuggestions: [
          { targetKind: 'rubric_criterion', targetId: 'audit-trail/has-reason', suggestedChange: { a: 1, b: 2 } },
        ],
      }),
      review('b', {
        rubricSuggestions: [
          { targetKind: 'rubric_criterion', targetId: 'audit-trail/has-reason', suggestedChange: { b: 2, a: 1 } },
        ],
      }),
    ];
    const g = groupSuggestions(reviews);
    const bucket = [...g.values()][0]!;
    expect(bucket.byChange.size).toBe(1);
  });
});

describe('SmeFeedbackAggregator.aggregateForQueueItem', () => {
  const REVIEWS = [
    review('a', {
      ontologySuggestions: [
        { targetKind: 'ontology_glossary', targetId: 'EOD', suggestedChange: { def: 'end-of-day' } },
      ],
    }),
    review('b', {
      ontologySuggestions: [
        { targetKind: 'ontology_glossary', targetId: 'EOD', suggestedChange: { def: 'end-of-day' } },
      ],
    }),
    review('c', {
      ontologySuggestions: [
        { targetKind: 'ontology_glossary', targetId: 'EOD', suggestedChange: { def: 'end-of-day' } },
      ],
    }),
  ];

  it('inserts an aggregated row when reviewer count + agreement cross thresholds', async () => {
    const { pool, calls } = makePool();
    const agg = new SmeFeedbackAggregator(pool, { minReviewers: 3, minAgreement: 0.66 });
    const r = await agg.aggregateForQueueItem({
      queueItemId: 'q-1',
      domainSlug: 'fintech',
      reviews: REVIEWS,
    });
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.groups[0]!.crossedThreshold).toBe(true);
    expect(r.groups[0]!.agreementRatio).toBe(1);
    const insert = calls.find((c) =>
      c.sql.includes('INSERT INTO oweibo.sme_aggregated_feedback'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params).toContain('fintech');
    expect(insert!.params).toContain('ontology_glossary');
    expect(insert!.params).toContain('EOD');
  });

  it("skips groups that don't cross thresholds (default below-threshold off)", async () => {
    const { pool, calls } = makePool();
    const agg = new SmeFeedbackAggregator(pool);
    // Only 2 reviewers — below default minReviewers=3.
    const r = await agg.aggregateForQueueItem({
      queueItemId: 'q-1',
      domainSlug: 'fintech',
      reviews: REVIEWS.slice(0, 2),
    });
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.sme_aggregated_feedback'))).toBe(false);
  });

  it("records below-threshold groups when recordBelowThreshold is on", async () => {
    const { pool, calls } = makePool();
    const agg = new SmeFeedbackAggregator(pool, {
      minReviewers: 3,
      minAgreement: 0.66,
      recordBelowThreshold: true,
    });
    const r = await agg.aggregateForQueueItem({
      queueItemId: 'q-1',
      domainSlug: 'fintech',
      reviews: REVIEWS.slice(0, 2),
    });
    expect(r.inserted).toBe(1);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.sme_aggregated_feedback'))).toBe(true);
  });

  it('selects the dominant suggestion when reviewers disagree (majority wins)', async () => {
    const { pool, calls } = makePool();
    const agg = new SmeFeedbackAggregator(pool, { minReviewers: 3, minAgreement: 0.66 });
    const reviews = [
      review('a', {
        ontologySuggestions: [
          { targetKind: 'ontology_glossary', targetId: 'NAV', suggestedChange: { def: 'net asset value' } },
        ],
      }),
      review('b', {
        ontologySuggestions: [
          { targetKind: 'ontology_glossary', targetId: 'NAV', suggestedChange: { def: 'net asset value' } },
        ],
      }),
      review('c', {
        ontologySuggestions: [
          { targetKind: 'ontology_glossary', targetId: 'NAV', suggestedChange: { def: 'navigation' } },
        ],
      }),
    ];
    const r = await agg.aggregateForQueueItem({
      queueItemId: 'q-1',
      domainSlug: 'fintech',
      reviews,
    });
    expect(r.groups[0]!.dominantSuggestion).toEqual({ def: 'net asset value' });
    // 2 of 3 = 0.666… >= 0.66 threshold.
    expect(r.groups[0]!.crossedThreshold).toBe(true);
    const insert = calls.find((c) =>
      c.sql.includes('INSERT INTO oweibo.sme_aggregated_feedback'),
    );
    expect(insert!.params).toContain(JSON.stringify({ def: 'net asset value' }));
  });

  it('returns empty result + writes nothing when reviews carry no suggestions', async () => {
    const { pool, calls } = makePool();
    const agg = new SmeFeedbackAggregator(pool);
    const r = await agg.aggregateForQueueItem({
      queueItemId: 'q-1',
      domainSlug: 'fintech',
      reviews: [review('a'), review('b'), review('c')],
    });
    expect(r.inserted).toBe(0);
    expect(r.groups).toEqual([]);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.sme_aggregated_feedback'))).toBe(false);
  });
});
