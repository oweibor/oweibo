/**
 * D.8 — DomainDepthMetrics tests.
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type {
  ComplianceCoverage,
  ConnectorCoverage,
  DomainCatalogEntry,
  DomainDepthInputs,
  EvalCoverage,
  OntologyCoverage,
  SmeCoverage,
} from '@oweibo/core-contracts';
import {
  DomainDepthMetrics,
  computeCompositeScore,
  readTargets,
  recommendTier,
  type DepthTargets,
} from '../DomainDepthMetrics.js';

const TARGETS: DepthTargets = {
  ontologyEntries: 300,
  rubricCount: 8,
  ruleCount: 20,
  verifiedConnectors: 10,
  credentialedSmes: 5,
};

const ENTRY: DomainCatalogEntry = {
  slug: 'fintech',
  displayName: 'Financial services',
  description: 'desc',
  category: 'regulated',
  compliancePostures: ['PCI-DSS'],
  archetypeRoles: ['CFO'],
  typicalConnectors: ['stripe'],
  canonicalVerbiage: ['payment'],
  registryVersion: '1.0.0',
  maturity: 'beta',
  depthTargets: { ...TARGETS },
};

describe('computeCompositeScore (pure)', () => {
  it('returns 0 for an empty domain (all inputs zero)', () => {
    const inputs: DomainDepthInputs = {
      ontologyEntries: 0,
      rubricCount: 0,
      ruleCount: 0,
      verifiedConnectors: 0,
      credentialedSmes: 0,
      weeklyReviewActivityScore: 0,
    };
    expect(computeCompositeScore(inputs, TARGETS)).toBe(0);
  });

  it('returns 100 when every component meets or exceeds its target', () => {
    const inputs: DomainDepthInputs = {
      ontologyEntries: 1000,
      rubricCount: 50,
      ruleCount: 100,
      verifiedConnectors: 50,
      credentialedSmes: 50,
      weeklyReviewActivityScore: 1,
    };
    expect(computeCompositeScore(inputs, TARGETS)).toBe(100);
  });

  it('weights components per the documented formula', () => {
    // Only ontology fully met (weight 0.2 × 100 = 20)
    const inputs: DomainDepthInputs = {
      ontologyEntries: 300,
      rubricCount: 0,
      ruleCount: 0,
      verifiedConnectors: 0,
      credentialedSmes: 0,
      weeklyReviewActivityScore: 0,
    };
    expect(computeCompositeScore(inputs, TARGETS)).toBe(20);
  });

  it('clamps weeklyReviewActivityScore to [0,1]', () => {
    const overshoot: DomainDepthInputs = {
      ontologyEntries: 0,
      rubricCount: 0,
      ruleCount: 0,
      verifiedConnectors: 0,
      credentialedSmes: 0,
      weeklyReviewActivityScore: 5, // would yield 50 unclamped
    };
    // weight 0.10 × 1 (clamped) × 100 = 10
    expect(computeCompositeScore(overshoot, TARGETS)).toBe(10);
  });

  it('treats target=0 as "skip the component" (no divide-by-zero)', () => {
    const zeroTargets: DepthTargets = {
      ontologyEntries: 0,
      rubricCount: 0,
      ruleCount: 0,
      verifiedConnectors: 0,
      credentialedSmes: 0,
    };
    const inputs: DomainDepthInputs = {
      ontologyEntries: 1000,
      rubricCount: 1000,
      ruleCount: 1000,
      verifiedConnectors: 1000,
      credentialedSmes: 1000,
      weeklyReviewActivityScore: 1,
    };
    // Only the weeklyActivity component (weight 0.1 × 1 × 100 = 10) contributes.
    expect(computeCompositeScore(inputs, zeroTargets)).toBe(10);
  });

  it('produces a half-saturated domain at ~50 (rule-of-thumb in plan §4 D.8)', () => {
    const half: DomainDepthInputs = {
      ontologyEntries: TARGETS.ontologyEntries / 2,
      rubricCount: TARGETS.rubricCount / 2,
      ruleCount: TARGETS.ruleCount / 2,
      verifiedConnectors: TARGETS.verifiedConnectors / 2,
      credentialedSmes: TARGETS.credentialedSmes / 2,
      weeklyReviewActivityScore: 0.5,
    };
    expect(computeCompositeScore(half, TARGETS)).toBe(50);
  });
});

describe('readTargets', () => {
  it('reads numeric targets from depthTargets', () => {
    expect(readTargets(ENTRY)).toEqual(TARGETS);
  });

  it('coalesces missing keys to 0', () => {
    const sparse: DomainCatalogEntry = { ...ENTRY, depthTargets: {} };
    expect(readTargets(sparse)).toEqual({
      ontologyEntries: 0,
      rubricCount: 0,
      ruleCount: 0,
      verifiedConnectors: 0,
      credentialedSmes: 0,
    });
  });
});

describe('recommendTier — hysteresis', () => {
  it('stays at current tier when streak too short to advance', () => {
    expect(recommendTier({ currentTier: 'experimental', recentScores: [60, 60, 60] })).toBe('experimental');
  });

  it('advances experimental → beta only after 4 consecutive ≥50 snapshots', () => {
    expect(
      recommendTier({ currentTier: 'experimental', recentScores: [60, 60, 60, 60] }),
    ).toBe('beta');
  });

  it('advances beta → general_availability only after 4 consecutive ≥75', () => {
    expect(
      recommendTier({ currentTier: 'beta', recentScores: [80, 80, 80, 80] }),
    ).toBe('general_availability');
  });

  it('streak broken by a single below-threshold reading restarts the count', () => {
    expect(
      recommendTier({ currentTier: 'experimental', recentScores: [60, 49, 60, 60, 60] }),
    ).toBe('experimental');
  });

  it('regresses beta → experimental only after 8 consecutive <50', () => {
    const eight = Array(8).fill(40);
    expect(recommendTier({ currentTier: 'beta', recentScores: eight })).toBe('experimental');
  });

  it('does not regress with only 7 consecutive low readings', () => {
    const seven = Array(7).fill(40);
    expect(recommendTier({ currentTier: 'beta', recentScores: seven })).toBe('beta');
  });

  it("deprecated is sticky — never auto-rebounds", () => {
    expect(
      recommendTier({ currentTier: 'deprecated', recentScores: [100, 100, 100, 100, 100, 100, 100, 100] }),
    ).toBe('deprecated');
  });
});

// ─── Service tests ────────────────────────────────────────────────────

interface QueryStub {
  match: string;
  rows: QueryResultRow[];
}

function makePool(stubs: QueryStub[]): { pool: Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queryFn = (sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params: params ?? [] });
    const matching = stubs
      .filter((s) => sql.includes(s.match))
      .sort((a, b) => b.match.length - a.match.length);
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

const COVERAGES = {
  ontology: {
    glossaryEntryCount: 10,
    namedEntityCount: 5,
    terminologyRuleCount: 3,
    disambiguationRuleCount: 2,
    nextReviewDays: 180,
  } as OntologyCoverage,
  eval: {
    rubricCount: 3,
    criterionCount: 8,
    criteriaWithDeterministicCheck: 6,
    criteriaWithLlmJudge: 1,
    criteriaWithSmeRequired: 1,
  } as EvalCoverage,
  compliance: {
    rulePackCount: 1,
    ruleCount: 2,
    compliancePostures: ['PCI-DSS'],
    actionClassExtensions: ['pci.cardholder_data_access'],
  } as ComplianceCoverage,
  connector: {
    certifiedConnectorCount: { experimental: 0, community: 1, verified: 2, enterprise: 0 },
    capabilityCount: 5,
  } as ConnectorCoverage,
  sme: {
    credentialedSmeCount: 2,
    weeklyReviewVolume: 10,
    meanInterRaterAgreement: 0.8,
  } as SmeCoverage,
};

const HALF_INPUTS: DomainDepthInputs = {
  ontologyEntries: 150,
  rubricCount: 4,
  ruleCount: 10,
  verifiedConnectors: 5,
  credentialedSmes: 2.5,
  weeklyReviewActivityScore: 0.5,
};

describe('DomainDepthMetrics.writeSnapshot', () => {
  it('persists a snapshot with the computed score and recommended tier', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.domain_depth_snapshots', rows: [] },
    ]);
    const svc = new DomainDepthMetrics(pool, { now: () => new Date('2026-05-28T00:00:00Z') });
    const out = await svc.writeSnapshot({
      catalogEntry: ENTRY,
      inputs: HALF_INPUTS,
      coverages: COVERAGES,
      recentScores: [],
    });
    expect(out.compositeScore).toBe(50);
    expect(out.recommendedTier).toBe('beta'); // current tier; no streak to advance
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.domain_depth_snapshots'));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain('fintech');
    expect(insert!.params).toContain(50);
    expect(insert!.params).toContain('beta');
  });

  it('advances recommendedTier when the latest 4 scores (including this one) clear the threshold', async () => {
    const { pool } = makePool([
      { match: 'INSERT INTO oweibo.domain_depth_snapshots', rows: [] },
    ]);
    const svc = new DomainDepthMetrics(pool, { now: () => new Date('2026-05-28T00:00:00Z') });
    const out = await svc.writeSnapshot({
      catalogEntry: { ...ENTRY, maturity: 'experimental' },
      inputs: HALF_INPUTS,
      coverages: COVERAGES,
      recentScores: [60, 60, 60], // plus the new 50 brings… wait
    });
    // The computed score is 50; recent = [50, 60, 60, 60]. Threshold 50,
    // streak of 4 → advance to beta.
    expect(out.compositeScore).toBe(50);
    expect(out.recommendedTier).toBe('beta');
  });

  it('rolls back on insert failure', async () => {
    const calls: string[] = [];
    const queryFn = (sql: string): Promise<QueryResult<QueryResultRow>> => {
      calls.push(sql);
      if (sql.includes('INSERT INTO oweibo.domain_depth_snapshots')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
    };
    const client = {
      query: jest.fn().mockImplementation(queryFn),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
    const svc = new DomainDepthMetrics(pool);
    await expect(
      svc.writeSnapshot({
        catalogEntry: ENTRY,
        inputs: HALF_INPUTS,
        coverages: COVERAGES,
      }),
    ).rejects.toThrow(/boom/);
    expect(calls.some((s) => s === 'ROLLBACK')).toBe(true);
  });
});

describe('DomainDepthMetrics.recentScores', () => {
  it('returns numeric scores newest first', async () => {
    const { pool } = makePool([
      {
        match: 'FROM oweibo.domain_depth_snapshots',
        rows: [{ composite_score: '75.50' }, { composite_score: 60 }, { composite_score: '55.00' }],
      },
    ]);
    const svc = new DomainDepthMetrics(pool);
    const r = await svc.recentScores('fintech');
    expect(r).toEqual([75.5, 60, 55]);
  });
});

describe('DomainDepthMetrics.writeTenantUtilization', () => {
  it('clamps utilization_ratio to [0,1]', async () => {
    const { pool, calls } = makePool([
      { match: 'INSERT INTO oweibo.tenant_domain_utilization', rows: [] },
    ]);
    const svc = new DomainDepthMetrics(pool);
    await svc.writeTenantUtilization({
      tenantId: '11111111-1111-1111-1111-111111111111',
      domainSlug: 'fintech',
      snapshotAt: '2026-05-28T00:00:00Z',
      ontologyRecallCount: 5,
      rubricEvaluationCount: 3,
      complianceEvaluationCount: 1,
      utilizationRatio: 1.5, // out of bound
    });
    const insert = calls.find((c) =>
      c.sql.includes('INSERT INTO oweibo.tenant_domain_utilization'),
    );
    expect(insert).toBeDefined();
    expect(insert!.params).toContain(1); // clamped
  });
});
