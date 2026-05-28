/**
 * D.7 — DomainCurrencyMonitor tests.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { IRegulatoryFeed, RegulatoryUpdate } from '@oweibo/core-contracts';
import { DomainCurrencyMonitor } from '../DomainCurrencyMonitor.js';

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
  rowCount?: number;
}

function makePool(stubs: QueryStub[]): {
  pool: Pool;
  calls: { sql: string; params: unknown[] }[];
} {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const matching = stubs
      .filter((s) => sql.includes(s.match))
      .sort((a, b) => b.match.length - a.match.length);
    const stub = matching[0];
    return Promise.resolve({
      rows: stub ? stub.rows : [],
      rowCount: stub ? stub.rowCount ?? stub.rows.length : 0,
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

const silent = () => undefined;

const FIXED_NOW = new Date('2026-05-28T00:00:00Z');

const updateA: RegulatoryUpdate = {
  updateId: 'u-1',
  publishedAt: '2026-05-27T00:00:00Z',
  title: 'New SEC rule',
  summary: 'summary',
  sourceUrl: 'https://example.test/1',
  impactArea: 'rule_pack',
  suggestedTargets: ['fintech-no-pan-in-logs'],
};

describe('DomainCurrencyMonitor.tick — state transitions', () => {
  it('transitions current → expiring_soon when within threshold', async () => {
    const validUntil = new Date(FIXED_NOW.getTime() + 5 * 86_400_000).toISOString();
    const { pool, calls } = makePool([
      {
        match: 'FROM oweibo.domain_artifact_currency',
        rows: [
          {
            artifact_kind: 'compliance_rule_pack',
            artifact_id: 'fintech@1.0.0-stub',
            domain_slug: 'fintech',
            valid_from: '2026-05-01T00:00:00Z',
            valid_until: validUntil,
            refresh_policy: 'manual',
            refresh_interval: null,
            feed_refs: [],
            state: 'current',
            superseded_by: null,
            last_state_transition: '2026-05-01T00:00:00Z',
          },
        ],
      },
      { match: 'UPDATE oweibo.domain_artifact_currency', rows: [], rowCount: 1 },
    ]);
    const m = new DomainCurrencyMonitor(pool, {
      now: () => FIXED_NOW,
      log: () => undefined,
    });
    const r = await m.tick();
    expect(r.transitions).toHaveLength(1);
    expect(r.transitions[0]!.to).toBe('expiring_soon');
    expect(
      calls.some((c) => c.sql.includes('UPDATE oweibo.domain_artifact_currency') && c.params.includes('expiring_soon')),
    ).toBe(true);
  });

  it('transitions to expired when valid_until <= now', async () => {
    const validUntil = new Date(FIXED_NOW.getTime() - 1).toISOString();
    const { pool } = makePool([
      {
        match: 'FROM oweibo.domain_artifact_currency',
        rows: [
          {
            artifact_kind: 'ontology_pack',
            artifact_id: 'healthcare@1.0.0-stub',
            domain_slug: 'healthcare',
            valid_from: '2026-05-01T00:00:00Z',
            valid_until: validUntil,
            refresh_policy: 'manual',
            refresh_interval: null,
            feed_refs: [],
            state: 'current',
            superseded_by: null,
            last_state_transition: '2026-05-01T00:00:00Z',
          },
        ],
      },
      { match: 'UPDATE oweibo.domain_artifact_currency', rows: [], rowCount: 1 },
    ]);
    const m = new DomainCurrencyMonitor(pool, { now: () => FIXED_NOW, log: () => undefined });
    const r = await m.tick();
    expect(r.transitions[0]!.to).toBe('expired');
  });

  it("does not transition artifacts whose state is already terminal ('superseded' / 'expired')", async () => {
    // The SELECT predicate excludes them; tick returns 0 transitions.
    const { pool } = makePool([
      { match: 'FROM oweibo.domain_artifact_currency', rows: [] },
    ]);
    const m = new DomainCurrencyMonitor(pool, { now: () => FIXED_NOW, log: () => undefined });
    const r = await m.tick();
    expect(r.transitions).toEqual([]);
    expect(r.artifactsScanned).toBe(0);
  });
});

describe('DomainCurrencyMonitor.runFeed — happy path', () => {
  function newFeed(): IRegulatoryFeed {
    return {
      feedId: 'sec-edgar',
      domainSlug: 'fintech',
      fetchUpdates: jest.fn().mockResolvedValue([updateA]),
    };
  }

  it('inserts every update + records success in domain_feed_health', async () => {
    const feed = newFeed();
    const { pool, calls } = makePool([
      {
        match: 'INSERT INTO oweibo.regulatory_feed_items',
        rows: [],
        rowCount: 1,
      },
      { match: 'INSERT INTO oweibo.domain_feed_health', rows: [] },
    ]);
    const m = new DomainCurrencyMonitor(pool, { now: () => FIXED_NOW, log: () => undefined });
    const n = await m.runFeed(feed);
    expect(n).toBe(1);
    const insertHealth = calls.find((c) => c.sql.includes('INSERT INTO oweibo.domain_feed_health'));
    expect(insertHealth).toBeDefined();
    expect(insertHealth!.params).toContain('sec-edgar');
  });

  it('skips when last_successful_at is within refreshInterval/4', async () => {
    const feed = newFeed();
    const recentSuccess = new Date(FIXED_NOW.getTime() - 60_000).toISOString();
    const { pool } = makePool([
      {
        match: 'FROM oweibo.domain_feed_health',
        rows: [
          {
            feed_id: 'sec-edgar',
            last_attempted_at: recentSuccess,
            last_successful_at: recentSuccess,
            last_error: null,
            consecutive_failures: 0,
          },
        ],
      },
      {
        match: 'MIN(EXTRACT(EPOCH FROM refresh_interval))',
        rows: [{ refresh_seconds: '86400' }], // 1 day → /4 = 6 h; 60 s of last success is well inside
      },
    ]);
    const m = new DomainCurrencyMonitor(pool, { now: () => FIXED_NOW, log: () => undefined });
    const n = await m.runFeed(feed);
    expect(n).toBe(0);
    expect(feed.fetchUpdates).not.toHaveBeenCalled();
  });
});

describe('DomainCurrencyMonitor.runFeed — failure path', () => {
  it('records failure in domain_feed_health and re-throws', async () => {
    const feed: IRegulatoryFeed = {
      feedId: 'failing-feed',
      domainSlug: 'fintech',
      fetchUpdates: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.domain_feed_health', rows: [] },
    ]);
    const m = new DomainCurrencyMonitor(pool, { now: () => FIXED_NOW, log: () => undefined });
    await expect(m.runFeed(feed)).rejects.toThrow(/boom/);
    const healthCall = calls.find((c) => c.sql.includes('INSERT INTO oweibo.domain_feed_health'));
    expect(healthCall).toBeDefined();
    expect(healthCall!.params).toContain('boom');
  });
});

describe('DomainCurrencyMonitor.tick — feed orchestration', () => {
  it('isolates one feed failure from another', async () => {
    const goodFeed: IRegulatoryFeed = {
      feedId: 'good',
      domainSlug: 'fintech',
      fetchUpdates: jest.fn().mockResolvedValue([updateA]),
    };
    const badFeed: IRegulatoryFeed = {
      feedId: 'bad',
      domainSlug: 'healthcare',
      fetchUpdates: jest.fn().mockRejectedValue(new Error('egress blocked')),
    };
    const { pool } = makePool([
      { match: 'FROM oweibo.domain_artifact_currency', rows: [] },
      { match: 'INSERT INTO oweibo.regulatory_feed_items', rows: [], rowCount: 1 },
      { match: 'INSERT INTO oweibo.domain_feed_health', rows: [] },
    ]);
    const m = new DomainCurrencyMonitor(pool, { now: () => FIXED_NOW, log: silent });
    m.registerFeed(goodFeed);
    m.registerFeed(badFeed);
    const r = await m.tick();
    expect(r.feedsAttempted).toBe(2);
    expect(r.feedItemsInserted).toBe(1);
    expect(r.feedFailures).toHaveLength(1);
    expect(r.feedFailures[0]!.feedId).toBe('bad');
  });

  it("registerFeed is idempotent (same feedId once)", () => {
    const { pool } = makePool([]);
    const m = new DomainCurrencyMonitor(pool, { now: () => FIXED_NOW });
    const f: IRegulatoryFeed = {
      feedId: 'sec-edgar',
      domainSlug: 'fintech',
      fetchUpdates: async () => [],
    };
    m.registerFeed(f);
    m.registerFeed(f);
    expect(m.registeredFeeds()).toEqual(['sec-edgar']);
  });
});
