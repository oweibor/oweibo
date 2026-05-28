/**
 * D.2 — DeterministicCheckExecutor tests.
 */
import type { RubricCriterion } from '@oweibo/core-contracts';
import {
  DeterministicCheckExecutor,
  composeExecutors,
} from '../DeterministicCheckExecutor.js';

const exec = new DeterministicCheckExecutor();

const crit = (id: string, fn: string, extra: Record<string, unknown> = {}): RubricCriterion => ({
  criterionId: id,
  description: id,
  check: 'deterministic',
  checkConfig: { fn, ...extra },
  weight: 1,
  failureBlocks: false,
});

const ctx = (extra: Record<string, unknown>) => ({
  tenantId: 't',
  taskId: 'task',
  taskKind: 'code_change',
  executorContext: extra,
});

describe('DeterministicCheckExecutor — grepCheck', () => {
  it('passes when pattern matches the modified-lines haystack', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'grepCheck', { pattern: 'actor_user_id' }),
      context: ctx({ modifiedLines: 'INSERT INTO ledger (actor_user_id, amount) VALUES (...)' }),
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it('fails when pattern does not match', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'grepCheck', { pattern: 'actor_user_id' }),
      context: ctx({ modifiedLines: 'INSERT INTO ledger (amount) VALUES (...)' }),
    });
    expect(r.passed).toBe(false);
    expect(r.skipped).toBeFalsy();
  });

  it('skips when haystack is missing', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'grepCheck', { pattern: 'foo' }),
      context: ctx({}),
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('missing_haystack');
  });

  it('supports artifact_body and audit_details scopes', async () => {
    const body = await exec.execute({
      criterion: crit('c', 'grepCheck', { pattern: 'hello', scope: 'artifact_body' }),
      context: ctx({ artifactBody: 'hello world' }),
    });
    expect(body.passed).toBe(true);

    const audit = await exec.execute({
      criterion: crit('c', 'grepCheck', { pattern: '"reason":"because"', scope: 'audit_details' }),
      context: ctx({ auditRow: { reason: 'because' } }),
    });
    expect(audit.passed).toBe(true);
  });
});

describe('DeterministicCheckExecutor — grepAbsent', () => {
  it('passes when pattern is absent', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'grepAbsent', { pattern: 'SELECT \\*' }),
      context: ctx({ modifiedLines: 'SELECT id FROM patient WHERE id = $1' }),
    });
    expect(r.passed).toBe(true);
  });

  it('fails when pattern is present', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'grepAbsent', { pattern: 'SELECT \\*' }),
      context: ctx({ modifiedLines: 'SELECT * FROM patient' }),
    });
    expect(r.passed).toBe(false);
  });
});

describe('DeterministicCheckExecutor — auditFieldPresent', () => {
  it('passes when field exists and meets minLength', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'auditFieldPresent', { field: 'reason', minLength: 5 }),
      context: ctx({ auditRow: { reason: 'long enough reason' } }),
    });
    expect(r.passed).toBe(true);
  });

  it('fails when value is too short', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'auditFieldPresent', { field: 'reason', minLength: 20 }),
      context: ctx({ auditRow: { reason: 'short' } }),
    });
    expect(r.passed).toBe(false);
  });

  it('fails when field is missing', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'auditFieldPresent', { field: 'reason' }),
      context: ctx({ auditRow: { actor_user_id: 'u' } }),
    });
    expect(r.passed).toBe(false);
  });

  it('skips when auditRow is missing entirely', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'auditFieldPresent', { field: 'reason' }),
      context: ctx({}),
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('missing_audit_row');
  });
});

describe('DeterministicCheckExecutor — unsupported / unknown', () => {
  it('skips non-deterministic checks', async () => {
    const r = await exec.execute({
      criterion: { ...crit('c', 'grepCheck'), check: 'llm_judge' },
      context: ctx({ modifiedLines: 'x' }),
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/unsupported_check_kind/);
  });

  it('skips unknown fn', async () => {
    const r = await exec.execute({
      criterion: crit('c', 'someUnknownFn'),
      context: ctx({ modifiedLines: 'x' }),
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/unknown_check_fn/);
  });
});

describe('composeExecutors', () => {
  it('first non-skipped result wins; subsequent executors are not consulted', async () => {
    const callOrder: string[] = [];
    const a = {
      async execute(input: { criterion: RubricCriterion }) {
        callOrder.push('a');
        return { criterionId: input.criterion.criterionId, score: 1, passed: true };
      },
    };
    const b = {
      async execute(input: { criterion: RubricCriterion }) {
        callOrder.push('b');
        return { criterionId: input.criterion.criterionId, score: 0, passed: false };
      },
    };
    const composed = composeExecutors(a, b);
    const r = await composed.execute({ criterion: crit('c', 'x'), context: ctx({}) });
    expect(r.passed).toBe(true);
    expect(callOrder).toEqual(['a']);
  });

  it('skipped result falls through to the next executor', async () => {
    const a = {
      async execute(input: { criterion: RubricCriterion }) {
        return {
          criterionId: input.criterion.criterionId,
          score: 0,
          passed: false,
          skipped: true,
          skipReason: 'no',
        };
      },
    };
    const b = {
      async execute(input: { criterion: RubricCriterion }) {
        return { criterionId: input.criterion.criterionId, score: 1, passed: true };
      },
    };
    const composed = composeExecutors(a, b);
    const r = await composed.execute({ criterion: crit('c', 'x'), context: ctx({}) });
    expect(r.passed).toBe(true);
  });
});
