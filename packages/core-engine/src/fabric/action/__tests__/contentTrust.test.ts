/**
 * ADR-011 §7 conformance suite — the content-trust / injection boundary,
 * pure. Content is data (never instruction); gating is content-independent
 * (INV-11); inspectors are upgrade-only; injection-suspect content is
 * quarantined.
 */
import { describe, it, expect } from '@jest/globals';
import {
  contentTrustLabel,
  gateActionClass,
  combineTrustVerdict,
  quarantineDecision,
  MODE_LATTICE,
  type TrustMode,
  type InspectorVerdict,
} from '../contentTrust.js';

describe('ADR-011 §3.1 — content is data, never instructions', () => {
  it('every connector origin labels as data; none yields instruction', () => {
    expect(contentTrustLabel('indexed_chunk')).toBe('data');
    expect(contentTrustLabel('live_mcp_result')).toBe('data');
    expect(contentTrustLabel('graph_context')).toBe('data');
  });
});

describe('ADR-011 §3.2 — content-independent gating (INV-11)', () => {
  it('action_class comes ONLY from the capability declaration, never the payload', () => {
    const cap = { capabilityId: 'send-message', actionClass: 'comm.external_message' };
    // The same capability yields the same class regardless of payload content,
    // including a payload crafted to look like an authorizing instruction.
    expect(gateActionClass(cap)).toBe('comm.external_message');
    // There is no payload parameter — content structurally cannot be an input.
    expect(gateActionClass({ capabilityId: 'pay', actionClass: 'financial.payment' })).toBe('financial.payment');
  });
});

describe('ADR-011 §3.3 — upgrade-only inspectors (monotonic)', () => {
  it('allow leaves the base mode unchanged', () => {
    for (const m of MODE_LATTICE) expect(combineTrustVerdict(m, 'allow')).toBe(m);
  });

  it('upgrade_to_approval raises to at least require_approval', () => {
    expect(combineTrustVerdict('execute', 'upgrade_to_approval')).toBe('require_approval');
    expect(combineTrustVerdict('dry_run', 'upgrade_to_approval')).toBe('require_approval');
    // already stricter → stays (forbidden is above require_approval)
    expect(combineTrustVerdict('forbidden', 'upgrade_to_approval')).toBe('forbidden');
  });

  it('forbid raises to forbidden from anywhere', () => {
    for (const m of MODE_LATTICE) expect(combineTrustVerdict(m, 'forbid')).toBe('forbidden');
  });

  it('NEVER returns a mode below the base — injected content cannot make the gate more permissive', () => {
    const rank = (m: TrustMode) => MODE_LATTICE.indexOf(m);
    const verdicts: InspectorVerdict[] = ['allow', 'upgrade_to_approval', 'forbid'];
    for (const base of MODE_LATTICE) {
      for (const v of verdicts) {
        expect(rank(combineTrustVerdict(base, v))).toBeGreaterThanOrEqual(rank(base));
      }
    }
  });

  it('the injection case: require_approval can never be lowered to execute', () => {
    for (const v of ['allow', 'upgrade_to_approval', 'forbid'] as InspectorVerdict[]) {
      expect(combineTrustVerdict('require_approval', v)).not.toBe('execute');
    }
  });
});

describe('ADR-011 §3.4 — quarantine excludes from context', () => {
  it('injection-suspect content is excluded, not deprioritized', () => {
    expect(quarantineDecision(true)).toBe('exclude_from_context');
    expect(quarantineDecision(false)).toBe('admit');
  });
});
