/**
 * S.0 — ActionPlanGate tests.
 *
 * Covers:
 *   - flag-off short-circuits to execute_each
 *   - structural validation (cycles, self-ref, unknown step, duplicates, empty)
 *   - hard-pinned classes force require_approval_for_plan
 *   - budget ceiling forces require_approval_for_plan
 *   - plan-level proposal row is written with step_number=NULL
 *   - blastRadius is computed and surfaced on every decision
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ActionPlanGate, validatePlanStructure } from '../ActionPlanGate.js';
import type { ActionPlan, PlannedAction } from '@oweibo/core-contracts';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const TASK = '33333333-3333-3333-3333-333333333333';

function makeAction(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    stepNumber: overrides.stepNumber ?? 1,
    actionClass: overrides.actionClass ?? 'write.local.scratch',
    summary: 'do thing',
    payload: {},
    blastRadiusContribution: overrides.blastRadiusContribution ?? {
      systems: ['local'], dataDomains: [], reversibility: 'trivial',
      costUsdCents: 0, reachUserCount: 0,
    },
    ...(overrides.dependsOn ? { dependsOn: overrides.dependsOn } : {}),
  };
}

function makePlan(actions: PlannedAction[]): ActionPlan {
  return {
    planId: '',
    tenantId: TENANT,
    userId: USER,
    originatingTaskId: TASK,
    title: 'test plan',
    actions,
    blastRadius: {
      systems: [], dataDomains: [], worstReversibility: 'trivial',
      estimatedCostUsdCents: 0, estimatedReachUserCount: 0,
    },
    atomicity: 'sequential_with_checkpoints',
    createdAt: new Date().toISOString(),
  };
}

interface QueryStub { match: string; rows: QueryResultRow[]; }

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
  const pool = { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, calls };
}

// ── validatePlanStructure ─────────────────────────────────────────────────

describe('validatePlanStructure', () => {
  it('rejects empty plan', () => {
    expect(validatePlanStructure([])).toEqual({ ok: false, error: 'empty plan' });
  });

  it('rejects duplicate step numbers', () => {
    const r = validatePlanStructure([makeAction({ stepNumber: 1 }), makeAction({ stepNumber: 1 })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate step 1/);
  });

  it('rejects unknown dependency step', () => {
    const r = validatePlanStructure([makeAction({ stepNumber: 1, dependsOn: [99] })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown step 99/);
  });

  it('rejects self-dependency', () => {
    const r = validatePlanStructure([makeAction({ stepNumber: 1, dependsOn: [1] })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/itself/);
  });

  it('detects a two-node cycle', () => {
    const r = validatePlanStructure([
      makeAction({ stepNumber: 1, dependsOn: [2] }),
      makeAction({ stepNumber: 2, dependsOn: [1] }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cycle/);
  });

  it('detects a three-node cycle', () => {
    const r = validatePlanStructure([
      makeAction({ stepNumber: 1, dependsOn: [3] }),
      makeAction({ stepNumber: 2, dependsOn: [1] }),
      makeAction({ stepNumber: 3, dependsOn: [2] }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cycle/);
  });

  it('accepts a valid DAG with diamond shape', () => {
    const r = validatePlanStructure([
      makeAction({ stepNumber: 1 }),
      makeAction({ stepNumber: 2, dependsOn: [1] }),
      makeAction({ stepNumber: 3, dependsOn: [1] }),
      makeAction({ stepNumber: 4, dependsOn: [2, 3] }),
    ]);
    expect(r).toEqual({ ok: true });
  });
});

// ── ActionPlanGate.gatePlan ──────────────────────────────────────────────

describe('ActionPlanGate.gatePlan', () => {
  it('short-circuits to execute_each when feature flag is off', async () => {
    const { pool, calls } = makePool([]);
    const gate = new ActionPlanGate(pool, { isEnabled: () => false });
    const decision = await gate.gatePlan(makePlan([makeAction()]));
    expect(decision.mode).toBe('execute_each');
    expect(calls).toHaveLength(0);
  });

  it('returns forbidden when plan structure is invalid (cycle)', async () => {
    const { pool } = makePool([]);
    const gate = new ActionPlanGate(pool, { isEnabled: () => true });
    const decision = await gate.gatePlan(makePlan([
      makeAction({ stepNumber: 1, dependsOn: [2] }),
      makeAction({ stepNumber: 2, dependsOn: [1] }),
    ]));
    expect(decision.mode).toBe('forbidden');
    expect(decision.reason).toMatch(/cycle/);
  });

  it('returns execute_each for safe single action plans', async () => {
    const { pool, calls } = makePool([]);
    const gate = new ActionPlanGate(pool, { isEnabled: () => true });
    const decision = await gate.gatePlan(makePlan([makeAction()]));
    expect(decision.mode).toBe('execute_each');
    // No INSERT into action_plans / action_proposals.
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.action_plans'))).toBe(false);
  });

  it('forces require_approval_for_plan when a member action is hard-pinned (financial.payment)', async () => {
    const { pool, calls } = makePool([
      { match: 'RETURNING id', rows: [{ id: 'proposal-abc' }] },
    ]);
    const gate = new ActionPlanGate(pool, { isEnabled: () => true });
    const decision = await gate.gatePlan(makePlan([
      makeAction({ stepNumber: 1 }),
      makeAction({ stepNumber: 2, actionClass: 'financial.payment' }),
    ]));
    expect(decision.mode).toBe('require_approval_for_plan');
    expect(decision.planProposalId).toBe('proposal-abc');
    // Plan-level proposal written with step_number=NULL.
    const insert = calls.find((c) => c.sql.includes('INSERT INTO oweibo.action_proposals'));
    expect(insert).toBeDefined();
    expect(insert?.sql).toMatch(/NULL,\s*\n?\s*'\{\}'/);
  });

  it('forces require_approval_for_plan when aggregate cost exceeds tenant ceiling', async () => {
    const { pool, calls } = makePool([
      { match: 'RETURNING id', rows: [{ id: 'over-budget' }] },
    ]);
    const gate = new ActionPlanGate(pool, {
      isEnabled: () => true,
      planCostCeilingUsdCents: async () => 1000, // $10 ceiling
    });
    const decision = await gate.gatePlan(makePlan([
      makeAction({
        blastRadiusContribution: {
          systems: ['stripe'], dataDomains: ['billing'],
          reversibility: 'reversible_with_cost', costUsdCents: 2000, reachUserCount: 0,
        },
      }),
    ]));
    expect(decision.mode).toBe('require_approval_for_plan');
    expect(decision.blastRadius.estimatedCostUsdCents).toBe(2000);
    expect(calls.some((c) => c.sql.includes('INSERT INTO oweibo.action_plans'))).toBe(true);
  });

  it('aggregates blast radius across all actions on every decision', async () => {
    const { pool } = makePool([]);
    const gate = new ActionPlanGate(pool, { isEnabled: () => true });
    const decision = await gate.gatePlan(makePlan([
      makeAction({
        stepNumber: 1,
        blastRadiusContribution: {
          systems: ['github'], dataDomains: ['code'],
          reversibility: 'trivial', costUsdCents: 0, reachUserCount: 0,
        },
      }),
      makeAction({
        stepNumber: 2,
        blastRadiusContribution: {
          systems: ['slack'], dataDomains: ['comm'],
          reversibility: 'reversible_with_cost', costUsdCents: 50, reachUserCount: 10,
        },
      }),
    ]));
    expect(decision.blastRadius.systems).toEqual(['github', 'slack']);
    expect(decision.blastRadius.dataDomains).toEqual(['code', 'comm']);
    expect(decision.blastRadius.worstReversibility).toBe('reversible_with_cost');
    expect(decision.blastRadius.estimatedCostUsdCents).toBe(50);
    expect(decision.blastRadius.estimatedReachUserCount).toBe(10);
  });
});
