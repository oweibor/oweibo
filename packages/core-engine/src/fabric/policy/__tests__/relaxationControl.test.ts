/**
 * ADR-006 §7 — INV-14 conformance: the relaxation lattice + dual control.
 *
 * Pure predicates; no DB. These are the ratification gate for ADR-006's
 * central claim: "a policy change is a relaxation unless it is PROVABLY a
 * tightening", and a relaxation cannot apply without a second approver.
 */
import {
  DIMENSION_CATEGORY,
  POLICY_DIMENSIONS,
  POLICY_RELAXATION_ACTION_CLASS,
  POLICY_RELAXATION_FLOOR,
  categoryOf,
  classifyChange,
  classifyChangeSet,
  evaluateQuorum,
  isCompliance,
  requiresBackfill,
  requiresDualControl,
  type PolicyValue,
} from '../contract';

const persistence = (allowed: boolean): PolicyValue => ({ kind: 'data_persistence', allowed });
const scope = (s: 'metadata' | 'full_content'): PolicyValue => ({ kind: 'indexing_scope', scope: s });
const exclusions = (...tags: string[]): PolicyValue => ({ kind: 'classification_exclusions', excludeTags: tags });
const residency = (region: string): PolicyValue => ({ kind: 'data_residency', region });
const enablement = (enabled: Record<string, boolean>): PolicyValue => ({ kind: 'connector_enablement', enabled });
const ops = (liveRead: boolean, liveWrite: boolean): PolicyValue => ({ kind: 'operation_permissions', liveRead, liveWrite });

describe('ADR-006 §3.1 — category is a property of the dimension', () => {
  it('the dimension→category map is total over POLICY_DIMENSIONS', () => {
    for (const d of POLICY_DIMENSIONS) {
      expect(DIMENSION_CATEGORY[d]).toBeDefined();
      expect(['compliance', 'operational']).toContain(categoryOf(d));
    }
  });

  it('connector_enablement is COMPLIANCE — §18.2 "absent, not merely deprioritized"', () => {
    // Operational enforcement (a planner input) is exactly "deprioritized",
    // which §18.2 explicitly rejects.
    expect(isCompliance('connector_enablement')).toBe(true);
  });

  it('data_residency is compliance — never a planner hint (§18.3)', () => {
    expect(isCompliance('data_residency')).toBe(true);
  });

  it('only freshness_sla and retrieval_preference are operational', () => {
    const operational = POLICY_DIMENSIONS.filter((d) => categoryOf(d) === 'operational');
    expect(operational.sort()).toEqual(['freshness_sla', 'retrieval_preference']);
  });
});

describe('ADR-006 §3.3 — the relaxation lattice', () => {
  it('no_change when the value is unchanged', () => {
    expect(classifyChange(scope('metadata'), scope('metadata'))).toBe('no_change');
    // Set equality is order-insensitive for exclusions.
    expect(classifyChange(exclusions('HR', 'Legal'), exclusions('Legal', 'HR'))).toBe('no_change');
  });

  it('provably tighter ⇒ tightening', () => {
    expect(classifyChange(persistence(true), persistence(false))).toBe('tightening');
    expect(classifyChange(scope('full_content'), scope('metadata'))).toBe('tightening');
    expect(classifyChange(ops(true, true), ops(true, false))).toBe('tightening');
    // Excluding MORE tags is more restrictive (superset ⊑ subset).
    expect(classifyChange(exclusions('HR'), exclusions('HR', 'Legal'))).toBe('tightening');
    // Disabling a connector is a tightening.
    expect(classifyChange(enablement({ slack: true }), enablement({ slack: false }))).toBe('tightening');
  });

  it('provably looser ⇒ relaxation', () => {
    expect(classifyChange(persistence(false), persistence(true))).toBe('relaxation');
    expect(classifyChange(scope('metadata'), scope('full_content'))).toBe('relaxation');
    expect(classifyChange(exclusions('HR', 'Legal'), exclusions('HR'))).toBe('relaxation');
    expect(classifyChange(enablement({ slack: false }), enablement({ slack: true }))).toBe('relaxation');
    expect(classifyChange(ops(true, false), ops(true, true))).toBe('relaxation');
  });

  it('INCOMPARABLE ⇒ relaxation — the fail-closed core of ADR-006 §1', () => {
    // {HR} → {Legal} is neither tighter nor looser, and it UNPROTECTS HR.
    // The ambiguous case must take the safe branch.
    expect(classifyChange(exclusions('HR'), exclusions('Legal'))).toBe('relaxation');
  });

  it('ANY region change is a relaxation — the platform never ranks regions legally', () => {
    expect(classifyChange(residency('us-east-1'), residency('eu-west-1'))).toBe('relaxation');
    expect(classifyChange(residency('eu-west-1'), residency('us-east-1'))).toBe('relaxation');
    // Identity is the only ⊑ for residency.
    expect(classifyChange(residency('us-east-1'), residency('us-east-1'))).toBe('no_change');
  });

  it('adding a newly-disabled connector key is not a relaxation (absent ⇒ disabled)', () => {
    expect(classifyChange(enablement({}), enablement({ github: false }))).toBe('no_change');
    expect(classifyChange(enablement({}), enablement({ github: true }))).toBe('relaxation');
  });

  it('equality is the lattice antisymmetry — equality and ordering cannot disagree', () => {
    // If equality were structural (JSON), {} vs {github:false} would read as a
    // TIGHTENING and trigger a mandatory whole-index backfill (§3.5) for a
    // change that means nothing. Antisymmetric equality makes that
    // unrepresentable.
    expect(classifyChange(enablement({}), enablement({ github: false }))).toBe('no_change');
    expect(classifyChange(enablement({ a: true, b: false }), enablement({ b: false, a: true }))).toBe('no_change');
    // Map-valued dimensions compare key-order-insensitively.
    expect(
      classifyChange(
        { kind: 'retrieval_preference', mode: { docs: 'live', tickets: 'index' } },
        { kind: 'retrieval_preference', mode: { tickets: 'index', docs: 'live' } },
      ),
    ).toBe('no_change');
  });

  it('a mixed change with ANY relaxation is a relaxation — bundling cannot launder', () => {
    // "tighten indexing_scope and incidentally move region" is a RELAXATION.
    expect(
      classifyChangeSet([
        { oldValue: scope('full_content'), newValue: scope('metadata') },   // tightening
        { oldValue: residency('us-east-1'), newValue: residency('eu-west-1') }, // relaxation
      ]),
    ).toBe('relaxation');
  });

  it('a mixed change of only tightenings is a tightening', () => {
    expect(
      classifyChangeSet([
        { oldValue: scope('full_content'), newValue: scope('metadata') },
        { oldValue: persistence(true), newValue: persistence(false) },
      ]),
    ).toBe('tightening');
  });

  it('relaxation ⇒ dual control; tightening ⇒ mandatory backfill', () => {
    expect(requiresDualControl('relaxation')).toBe(true);
    expect(requiresDualControl('tightening')).toBe(false);
    expect(requiresBackfill('tightening')).toBe(true);   // §18.5 stale data never left in place
    expect(requiresBackfill('relaxation')).toBe(false);
  });
});

describe('ADR-006 §3.4 — dual control floor', () => {
  it('grants and delegation are PROHIBITED for the reserved class', () => {
    // A grant is pre-approval; pre-approved dual control is single control.
    // Delegation lets one admin hold both votes. Both defeat §22's mitigation.
    expect(POLICY_RELAXATION_FLOOR.allowGrants).toBe(false);
    expect(POLICY_RELAXATION_FLOOR.allowDelegation).toBe(false);
    expect(POLICY_RELAXATION_FLOOR.quorum).toBeGreaterThanOrEqual(2);
    expect(POLICY_RELAXATION_ACTION_CLASS).toBe('governance.policy_relaxation');
  });

  it('the proposer ALONE never reaches quorum', () => {
    const v = evaluateQuorum('admin-a', [{ principalId: 'admin-a', approve: true }]);
    expect(v.kind).toBe('pending');
  });

  it('one principal voting twice is ONE vote — no self-approval by repetition', () => {
    const v = evaluateQuorum('admin-a', [
      { principalId: 'admin-a', approve: true },
      { principalId: 'admin-a', approve: true },
    ]);
    expect(v.kind).toBe('pending');
  });

  it('proposer + 1 independent approver reaches quorum — exactly §22\'s "second approver"', () => {
    const v = evaluateQuorum('admin-a', [
      { principalId: 'admin-a', approve: true },
      { principalId: 'admin-b', approve: true },
    ]);
    expect(v.kind).toBe('approved');
    if (v.kind === 'approved') expect(v.approvers.sort()).toEqual(['admin-a', 'admin-b']);
  });

  it('two non-proposing approvers also reach quorum', () => {
    const v = evaluateQuorum('admin-a', [
      { principalId: 'admin-b', approve: true },
      { principalId: 'admin-c', approve: true },
    ]);
    expect(v.kind).toBe('approved');
  });

  it('dissent vetoes', () => {
    const v = evaluateQuorum('admin-a', [
      { principalId: 'admin-a', approve: true },
      { principalId: 'admin-b', approve: false },
    ]);
    expect(v.kind).toBe('vetoed');
    if (v.kind === 'vetoed') expect(v.by).toBe('admin-b');
  });

  it("a principal's later dissent overrides their own earlier approval — dissent cannot be raced out", () => {
    const v = evaluateQuorum('admin-a', [
      { principalId: 'admin-b', approve: true },
      { principalId: 'admin-a', approve: true },
      { principalId: 'admin-b', approve: false }, // b withdraws
    ]);
    expect(v.kind).toBe('vetoed');
    if (v.kind === 'vetoed') expect(v.by).toBe('admin-b');
  });
});
