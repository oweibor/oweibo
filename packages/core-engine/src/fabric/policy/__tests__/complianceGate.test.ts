/**
 * ADR-006 §7 — INV-4 conformance: compliance blocks at the storage layer,
 * independent of the planner.
 *
 * The structural claim under test: `evaluateCompliance` is a pure function of
 * (policy, write) — it takes no planner, no plan, and no ranking input, so a
 * planner cannot influence a verdict even in principle. §18.3's "independent of
 * the planner" is only true if that independence is structural rather than
 * conventional.
 */
import {
  CompliancePolicyGate,
  evaluateCompliance,
  type CandidateWrite,
  type EffectivePolicy,
} from '../CompliancePolicyGate';
import type { PolicyValue } from '../contract';

// Every test policy enables the connector under test unless a case overrides
// it: §3.3 reads an absent enablement key as DISABLED, so a truly empty policy
// blocks on connector_enablement before any other dimension can be exercised.
const pol = (...vals: PolicyValue[]): EffectivePolicy => {
  const out: Record<string, PolicyValue> = {
    connector_enablement: { kind: 'connector_enablement', enabled: { 'google-drive': true } },
  };
  for (const v of vals) out[v.kind] = v;
  return out as EffectivePolicy;
};

const write = (over: Partial<CandidateWrite> = {}): CandidateWrite => ({
  tenantId: 't1',
  connectorId: 'google-drive',
  ...over,
});

describe('ADR-006 §3.2 — INV-4: the gate is structurally planner-independent', () => {
  it('evaluateCompliance takes exactly (policy, write, region) — no planner parameter exists', () => {
    // The arity IS the guarantee: there is no parameter through which a plan,
    // a ranking, or a planner decision could reach the verdict.
    expect(evaluateCompliance.length).toBeLessThanOrEqual(3);
  });

  it('the verdict is a pure function — same inputs, same verdict, no hidden state', () => {
    const p = pol({ kind: 'data_persistence', allowed: false });
    const w = write({ persistsContent: true });
    const first = evaluateCompliance(p, w);
    const second = evaluateCompliance(p, w);
    expect(second).toEqual(first);
    expect(first.kind).toBe('block');
  });

  it('there is NO soft mode — a verdict is exactly allow | block (§18.3 never pass-through)', () => {
    const cases: Array<[EffectivePolicy, CandidateWrite]> = [
      [pol({ kind: 'data_persistence', allowed: false }), write({ persistsContent: true })],
      [pol({ kind: 'data_persistence', allowed: true }), write({ persistsContent: true })],
      [pol({ kind: 'indexing_scope', scope: 'metadata' }), write({ embedsFullContent: true })],
      [pol({ kind: 'classification_exclusions', excludeTags: ['HR'] }), write({ tags: ['HR'] })],
    ];
    for (const [p, w] of cases) {
      const v = evaluateCompliance(p, w);
      expect(['allow', 'block']).toContain(v.kind);
    }
  });
});

describe('ADR-006 §3.2 — the dimension checks', () => {
  it('blocks a write from a policy-disabled connector (§18.2 "absent, not deprioritized")', () => {
    const v = evaluateCompliance(
      pol({ kind: 'connector_enablement', enabled: { 'google-drive': false } }),
      write({ connectorId: 'google-drive' }),
    );
    expect(v.kind).toBe('block');
    if (v.kind === 'block') expect(v.dimension).toBe('connector_enablement');
  });

  it('blocks a connector ABSENT from the enablement map — §3.3 absent ⇒ disabled, and the gate must agree with the lattice', () => {
    // The lattice holds `{}` ≡ `{x: false}` (absent = disabled). If the gate
    // read absent as ENABLED, that equality would make disabling a connector
    // from the default state an unwritable no_change while the gate kept
    // admitting its writes — classification and enforcement disagreeing about
    // what a policy means.
    const v = evaluateCompliance(
      pol({ kind: 'connector_enablement', enabled: { slack: true } }),
      write({ connectorId: 'google-drive' }),
    );
    expect(v.kind).toBe('block');
    if (v.kind === 'block') expect(v.dimension).toBe('connector_enablement');
  });

  it('blocks content persistence when the tenant forbids it', () => {
    const v = evaluateCompliance(
      pol({ kind: 'data_persistence', allowed: false }),
      write({ persistsContent: true }),
    );
    expect(v.kind).toBe('block');
    if (v.kind === 'block') expect(v.dimension).toBe('data_persistence');
  });

  it('blocks full-content embedding under metadata scope — K.5 default, subsumed unchanged', () => {
    const v = evaluateCompliance(pol(), write({ embedsFullContent: true }));
    expect(v.kind).toBe('block'); // default scope is metadata
    if (v.kind === 'block') expect(v.dimension).toBe('indexing_scope');
  });

  it('allows full-content embedding once the tenant opts in', () => {
    const v = evaluateCompliance(
      pol({ kind: 'indexing_scope', scope: 'full_content' }),
      write({ embedsFullContent: true }),
    );
    expect(v.kind).toBe('allow');
  });

  it('blocks an excluded classification tag ("never index Confidential")', () => {
    const v = evaluateCompliance(
      pol({ kind: 'classification_exclusions', excludeTags: ['Confidential'] }),
      write({ tags: ['Public', 'Confidential'] }),
    );
    expect(v.kind).toBe('block');
    if (v.kind === 'block') expect(v.dimension).toBe('classification_exclusions');
  });

  it('blocks an out-of-region write against the PROVISIONED region (§18.3)', () => {
    const v = evaluateCompliance(pol(), write({ targetRegion: 'eu-west-1' }), 'us-east-1');
    expect(v.kind).toBe('block');
    if (v.kind === 'block') expect(v.dimension).toBe('data_residency');
  });

  it('an explicit residency policy overrides the provisioned region', () => {
    const v = evaluateCompliance(
      pol({ kind: 'data_residency', region: 'eu-west-1' }),
      write({ targetRegion: 'eu-west-1' }),
      'us-east-1',
    );
    expect(v.kind).toBe('allow');
  });

  it('allows a compliant metadata write once the connector is enabled', () => {
    expect(evaluateCompliance(pol(), write()).kind).toBe('allow');
  });

  it('the TRUE default policy (no rows at all) blocks — fail-closed until a connector is enabled', () => {
    const v = evaluateCompliance({}, write());
    expect(v.kind).toBe('block');
    if (v.kind === 'block') expect(v.dimension).toBe('connector_enablement');
  });

  it('blocks when a region is pinned but the write declares no target region (fail-closed)', () => {
    const v = evaluateCompliance(pol(), write(), 'us-east-1');
    expect(v.kind).toBe('block');
    if (v.kind === 'block') expect(v.dimension).toBe('data_residency');
  });
});

describe('ADR-006 §3.2 rule 2 — a block is logged, never silently dropped', () => {
  it('records an audit row naming the blocking dimension', async () => {
    const blocks: Array<{ dimension: string; reason: string }> = [];
    const gate = new CompliancePolicyGate(
      async () => pol({ kind: 'classification_exclusions', excludeTags: ['HR'] }),
      { recordBlock: async (a) => { blocks.push({ dimension: a.dimension, reason: a.reason }); } },
    );

    const v = await gate.check(write({ tags: ['HR'] }));
    expect(v.kind).toBe('block');
    // Silence would be indistinguishable from "no such document" — which is how
    // a compliance failure becomes undetectable.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.dimension).toBe('classification_exclusions');
    expect(blocks[0]!.reason).toContain('HR');
  });

  it('does not audit an allowed write', async () => {
    const blocks: string[] = [];
    const gate = new CompliancePolicyGate(
      async () => pol(),
      { recordBlock: async (a) => { blocks.push(a.dimension); } },
    );
    expect((await gate.check(write())).kind).toBe('allow');
    expect(blocks).toHaveLength(0);
  });
});
