/**
 * ADR-001 §7 conformance suite — the pure planner contract predicates,
 * shipped green at ratification. INV-2 (rank after ACL), INV-3 (Critical
 * never cached), INV-13 (cache never cross-identity), and the INV-4 ordering
 * witness (compliance gate first), plus the ADR-001-owned behavioral
 * contracts (fallback-table totality, quota §7.5 Critical-no-fallback,
 * freshness decision, intent classification).
 *
 * No DB, no live source: these are the governance artifacts. The K.4 battery
 * arms live index-path execution and the per-fallback-row behavioral tests.
 */
import { describe, it, expect } from '@jest/globals';
import {
  PLAN_STAGE_ORDER,
  assertStageOrder,
  classifyIntent,
  SUPPORT_FLAGS,
  FALLBACK_POLICY,
  negotiateCapabilities,
  QUOTA_EXHAUSTION_POLICY,
  analyzeFreshness,
  deriveCacheKey,
  isCacheable,
  type PlanStageName,
  type SupportFlag,
} from '../contract.js';

describe('ADR-001 §3.3 — fixed stage order (INV-2 + Flow-2 ordering)', () => {
  it('compliance_gate precedes classify_intent (INV-4 ordering witness)', () => {
    expect(PLAN_STAGE_ORDER.indexOf('compliance_gate')).toBeLessThan(
      PLAN_STAGE_ORDER.indexOf('classify_intent'),
    );
  });

  it('acl_filter precedes rank (INV-2)', () => {
    expect(PLAN_STAGE_ORDER.indexOf('acl_filter')).toBeLessThan(
      PLAN_STAGE_ORDER.indexOf('rank'),
    );
  });

  it('accepts a monotonic subsequence of the canonical order', () => {
    const stages: PlanStageName[] = ['compliance_gate', 'classify_intent', 'acl_filter', 'rank'];
    expect(() => assertStageOrder(stages)).not.toThrow();
  });

  it('rejects a plan that ranks before ACL filtering (INV-2)', () => {
    const stages: PlanStageName[] = ['acl_filter', 'rank'];
    // deliberately reversed:
    expect(() => assertStageOrder(['rank', 'acl_filter'])).toThrow(/INV-2/);
    expect(() => assertStageOrder(stages)).not.toThrow();
  });

  it('rejects a plan that classifies before the compliance gate', () => {
    expect(() => assertStageOrder(['classify_intent', 'compliance_gate'])).toThrow();
  });

  it('rejects a duplicated stage (non-strict increase)', () => {
    expect(() => assertStageOrder(['rank', 'rank'])).toThrow();
  });
});

describe('ADR-001 §3.1 — intent classification (v0)', () => {
  it('classifies the four §7.2 example queries', () => {
    expect(classifyIntent('What is our PTO policy?')).toBe('retrieval');
    expect(classifyIntent('Has finance approved invoice 491?')).toBe('lookup');
    expect(classifyIntent('Who owns Project Atlas?')).toBe('lookup');
    expect(classifyIntent('Summarize all design docs updated last month.')).toBe('retrieval');
  });

  it('classifies a compound query (retrieval feeding an action)', () => {
    expect(
      classifyIntent('Summarize the design docs and file a Jira ticket about the gaps'),
    ).toBe('compound');
  });

  it('classifies a bare action query', () => {
    expect(classifyIntent('Create a calendar invite for Monday')).toBe('action');
  });
});

describe('ADR-001 §3.4 — fallback table (total over SUPPORT_FLAGS)', () => {
  it('every SupportFlag has exactly one fallback policy (totality)', () => {
    for (const flag of SUPPORT_FLAGS) {
      expect(FALLBACK_POLICY[flag]).toBeDefined();
    }
    // No stray keys beyond the certified vocabulary.
    expect(Object.keys(FALLBACK_POLICY).sort()).toEqual([...SUPPORT_FLAGS].sort());
  });

  it('a missing capability yields its policy; a present one yields none', () => {
    const decisions = negotiateCapabilities(['deltaSync', 'webhooks', 'groups'], {
      deltaSync: true,
      // webhooks absent → missing; groups false → missing
      groups: false,
    });
    const byCap = Object.fromEntries(decisions.map((d) => [d.capability, d]));
    expect(byCap.deltaSync!.missing).toBe(false);
    expect(byCap.deltaSync!.policy).toBeUndefined();
    expect(byCap.webhooks!.missing).toBe(true);
    expect(byCap.webhooks!.policy).toBe('scheduled_polling');
    expect(byCap.groups!.missing).toBe(true);
    expect(byCap.groups!.policy).toBe('validate_acl_live');
  });

  it('A3: absent/NULL effective capabilities mean every required flag is missing (fail-closed)', () => {
    for (const eff of [null, undefined, {}]) {
      const decisions = negotiateCapabilities([...SUPPORT_FLAGS], eff);
      expect(decisions.every((d) => d.missing)).toBe(true);
      expect(decisions.every((d) => d.policy !== undefined)).toBe(true);
    }
  });

  it('maps the exit-gate example: no-webhooks connector falls back to polling', () => {
    const [decision] = negotiateCapabilities(['webhooks'], { webhooks: false });
    expect(decision!.policy).toBe('scheduled_polling');
  });
});

describe('ADR-001 §3.5 — quota exhaustion fork (§7.5)', () => {
  it('Static/Operational/Transactional fall back to index', () => {
    expect(QUOTA_EXHAUSTION_POLICY.static.fallBackToIndex).toBe(true);
    expect(QUOTA_EXHAUSTION_POLICY.operational.fallBackToIndex).toBe(true);
    expect(QUOTA_EXHAUSTION_POLICY.transactional.fallBackToIndex).toBe(true);
  });

  it('Critical NEVER falls back — it errors and alerts (INV-3-adjacent)', () => {
    expect(QUOTA_EXHAUSTION_POLICY.critical.fallBackToIndex).toBe(false);
    expect(QUOTA_EXHAUSTION_POLICY.critical.errorAndAlert).toBe(true);
  });

  it('staleness tagging escalates by class', () => {
    expect(QUOTA_EXHAUSTION_POLICY.static.attachStalenessWarning).toBe(false);
    expect(QUOTA_EXHAUSTION_POLICY.operational.attachStalenessWarning).toBe(true);
    expect(QUOTA_EXHAUSTION_POLICY.transactional.logQuotaEvent).toBe(true);
  });
});

describe('ADR-001 §3 — freshness analysis (document-level)', () => {
  const now = 1_000_000_000_000;

  it('Critical always requires live validation (§6.4, bound 0)', () => {
    const d = analyzeFreshness('critical', now - 5, now);
    expect(d.requiresLive).toBe(true);
    expect(d.meetsIndexTolerance).toBe(false);
  });

  it('a fresh Operational index meets tolerance (no live check)', () => {
    const d = analyzeFreshness('operational', now - 1000, now); // 1s < 15m bound
    expect(d.meetsIndexTolerance).toBe(true);
    expect(d.requiresLive).toBe(false);
    expect(d.maxDataAgeMs).toBeNull();
  });

  it('a stale Operational index requires live and reports the bound', () => {
    const d = analyzeFreshness('operational', now - 20 * 60 * 1000, now); // 20m > 15m
    expect(d.meetsIndexTolerance).toBe(false);
    expect(d.requiresLive).toBe(true);
    expect(d.maxDataAgeMs).toBe(15 * 60 * 1000);
  });

  it('Static tolerates a week-old index', () => {
    const d = analyzeFreshness('static', now - 6 * 24 * 60 * 60 * 1000, now);
    expect(d.meetsIndexTolerance).toBe(true);
  });
});

describe('ADR-001 §3.6 — semantic cache contract (INV-3, INV-13)', () => {
  const base = {
    tenantId: 't1',
    canonicalIdentity: 'alice@x.com',
    policyVersion: 'v3',
    intentEmbeddingRef: 'emb-abc',
  };

  it('INV-13: changing ONLY the identity changes the key', () => {
    const a = deriveCacheKey(base);
    const b = deriveCacheKey({ ...base, canonicalIdentity: 'bob@x.com' });
    expect(a).not.toBe(b);
  });

  it('INV-13: identical inputs derive the identical key (deterministic)', () => {
    expect(deriveCacheKey(base)).toBe(deriveCacheKey({ ...base }));
  });

  it('INV-13: no delimiter forgery — an embedded "|" cannot alias another identity', () => {
    // Two identities that would collide under a naive join('|') must not collide.
    const x = deriveCacheKey({ ...base, tenantId: 't', canonicalIdentity: '1|alice' });
    const y = deriveCacheKey({ ...base, tenantId: 't1', canonicalIdentity: 'alice' });
    expect(x).not.toBe(y);
  });

  it('INV-3: Critical-class content is never cacheable', () => {
    expect(isCacheable('critical')).toBe(false);
  });

  it('non-Critical classes are cacheable (subject to the K.5 runtime checks)', () => {
    expect(isCacheable('static')).toBe(true);
    expect(isCacheable('operational')).toBe(true);
    expect(isCacheable('transactional')).toBe(true);
  });
});
