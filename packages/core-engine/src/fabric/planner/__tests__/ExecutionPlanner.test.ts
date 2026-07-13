/**
 * K.4 planner behavioral suite (pure — no DB). The roadmap exit gate's two
 * halves that don't need a live deployment:
 *   • the four §7.2 example queries produce the documented plan shapes;
 *   • each fallback-table row has a behavioral test (no-webhooks polls, etc.).
 * Plus: compliance gate precedes classification (§3.2), action-step removal,
 * and compound → ordered plan DAG (§3.7).
 *
 * The live index-path execution half of the exit gate is in
 * fabric/__tests__/k4-battery.integration.test.ts (needs TEST_DATABASE_URL).
 */
import { describe, it, expect } from '@jest/globals';
import {
  ExecutionPlanner,
  negotiateConnector,
  type ConnectorSnapshot,
  type PlanInput,
  type ExecutionPlan,
  type PlanDAG,
} from '../ExecutionPlanner.js';
import { SUPPORT_FLAGS, type SupportFlag } from '../contract.js';

const planner = new ExecutionPlanner();

/** A fully-capable enabled connector; tests knock out one flag at a time. */
function connector(overrides: Partial<ConnectorSnapshot> = {}): ConnectorSnapshot {
  return {
    connectorId: 'google-drive',
    enabled: true,
    capabilityVersion: '2.4',
    heartbeatSeconds: 300,
    effectiveCapabilities: Object.fromEntries(SUPPORT_FLAGS.map((f) => [f, true])),
    ...overrides,
  };
}

function baseInput(query: string, overrides: Partial<PlanInput> = {}): PlanInput {
  return { tenantId: 't1', query, connectors: [connector()], ...overrides };
}

describe('ADR-001 §3.7 — the four §7.2 example plan shapes', () => {
  it('"What is our PTO policy?" → retrieval / index / no fallback / no live', () => {
    const p = planner.plan(baseInput('What is our PTO policy?')) as ExecutionPlan;
    expect(p.blocked).toBe(false);
    expect(p.intent).toBe('retrieval');
    expect(p.primaryPath).toBe('index');
    expect(p.maxDataAgeMs).toBeNull();
  });

  it('"Has finance approved invoice 491?" → lookup / live_mcp / max age 30s', () => {
    const p = planner.plan(baseInput('Has finance approved invoice 491?')) as ExecutionPlan;
    expect(p.intent).toBe('lookup');
    expect(p.primaryPath).toBe('live_mcp');
    expect(p.fallbackPath).toBeNull();
    expect(p.maxDataAgeMs).toBe(30_000);
  });

  it('"Who owns Project Atlas?" → lookup / graph / fallback index', () => {
    const p = planner.plan(baseInput('Who owns Project Atlas?')) as ExecutionPlan;
    expect(p.intent).toBe('lookup');
    expect(p.primaryPath).toBe('graph');
    expect(p.fallbackPath).toBe('index');
  });

  it('"Summarize all design docs updated last month." → retrieval / hybrid', () => {
    const p = planner.plan(baseInput('Summarize all design docs updated last month.')) as ExecutionPlan;
    expect(p.intent).toBe('retrieval');
    expect(p.primaryPath).toBe('hybrid');
  });
});

describe('ADR-001 §3.4 — each fallback-table row is behaviorally observable', () => {
  it('no-webhooks connector observably POLLS (the exit-gate example)', () => {
    const p = planner.plan(baseInput('What is our PTO policy?', {
      connectors: [connector({ effectiveCapabilities: { ...allBut('webhooks') } })],
    })) as ExecutionPlan;
    const d = p.connectorDirectives[0]!;
    expect(d.sync).toBe('poll');
    expect(d.appliedFallbacks).toContain('scheduled_polling');
  });

  it('no-deltaSync connector forces a full sync', () => {
    const d = negotiateConnector(connector({ effectiveCapabilities: allBut('deltaSync') }), [...SUPPORT_FLAGS]);
    expect(d.fullSync).toBe(true);
    expect(d.appliedFallbacks).toContain('force_full_sync');
  });

  it('no-groups connector validates ACLs live at retrieval', () => {
    const d = negotiateConnector(connector({ effectiveCapabilities: allBut('groups') }), [...SUPPORT_FLAGS]);
    expect(d.aclValidateLive).toBe(true);
  });

  it('no-activitySignals connector ranks without activity boosts', () => {
    const d = negotiateConnector(connector({ effectiveCapabilities: allBut('activitySignals') }), [...SUPPORT_FLAGS]);
    expect(d.activityBoost).toBe(false);
  });

  it('no-content connector serves index-only and flags staleness', () => {
    const d = negotiateConnector(connector({ effectiveCapabilities: allBut('content') }), [...SUPPORT_FLAGS]);
    expect(d.indexOnlyFlagStaleness).toBe(true);
  });

  it('no-acl connector is marked ACL-untrusted (retrieval withholds per ADR-010)', () => {
    const d = negotiateConnector(connector({ effectiveCapabilities: allBut('acl') }), [...SUPPORT_FLAGS]);
    expect(d.aclUntrusted).toBe(true);
  });

  it('a fully-capable connector applies no fallbacks (webhook, no full sync)', () => {
    const d = negotiateConnector(connector(), [...SUPPORT_FLAGS]);
    expect(d.sync).toBe('webhook');
    expect(d.fullSync).toBe(false);
    expect(d.appliedFallbacks).toHaveLength(0);
  });
});

describe('ADR-001 §3.4 — enabled-only negotiation (§10.4)', () => {
  it('a disabled connector never enters negotiation', () => {
    const p = planner.plan(baseInput('What is our PTO policy?', {
      connectors: [connector({ connectorId: 'jira', enabled: false }), connector()],
    })) as ExecutionPlan;
    expect(p.connectorDirectives.map((d) => d.connectorId)).toEqual(['google-drive']);
  });
});

describe('ADR-001 §3.2 — compliance gate precedes classification (Flow 2)', () => {
  it('a blocking gate yields a BlockedPlan with no paths, no intent', () => {
    const out = planner.plan(baseInput('What is our PTO policy?', {
      complianceGate: () => 'block',
    }));
    expect(out.blocked).toBe(true);
    if (out.blocked) expect(out.reason).toBe('compliance_gate');
    expect('primaryPath' in out).toBe(false);
  });

  it('a throwing gate fails closed (blocks)', () => {
    const out = planner.plan(baseInput('What is our PTO policy?', {
      complianceGate: () => { throw new Error('policy service down'); },
    }));
    expect(out.blocked).toBe(true);
  });

  it('an allowing gate proceeds to a normal plan', () => {
    const out = planner.plan(baseInput('What is our PTO policy?', { complianceGate: () => 'allow' }));
    expect(out.blocked).toBe(false);
  });
});

describe('ADR-001 §3.4 — action-step removal when actions capability is missing', () => {
  it('drops action steps for a connector lacking `actions`', () => {
    const p = planner.plan(baseInput('Create a calendar invite for Monday', {
      connectors: [connector({ effectiveCapabilities: allBut('actions') })],
    })) as ExecutionPlan;
    expect(p.intent).toBe('action');
    expect(p.steps).toHaveLength(0); // removed — no actions capability
  });

  it('keeps action steps for a connector that supports `actions`', () => {
    const p = planner.plan(baseInput('Create a calendar invite for Monday', {
      connectors: [connector()],
    })) as ExecutionPlan;
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.kind).toBe('action');
  });
});

describe('ADR-001 §3.7 — compound query decomposes into an ordered plan DAG', () => {
  it('"summarize … and file a Jira ticket" → [retrieval, action] sub-plans', () => {
    const out = planner.plan(baseInput('Summarize the design docs and file a Jira ticket about the gaps')) as PlanDAG;
    expect(out.intent).toBe('compound');
    expect(out.subPlans.map((s) => s.intent)).toEqual(['retrieval', 'action']);
    // Each sub-plan is independently a well-formed plan (never gated once at top).
    expect(out.subPlans.every((s) => s.blocked === false)).toBe(true);
  });
});

/** All SupportFlags true except the named one (which is false). */
function allBut(missing: SupportFlag): Record<SupportFlag, boolean> {
  return Object.fromEntries(SUPPORT_FLAGS.map((f) => [f, f !== missing])) as Record<SupportFlag, boolean>;
}
