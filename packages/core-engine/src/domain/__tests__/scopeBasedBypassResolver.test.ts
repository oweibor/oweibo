/**
 * F.2.5 — unit tests for scopeBasedBypassResolver.
 *
 * Covers the four bypassPolicy × scope combinations plus the
 * "no scopes" default-deny path. The resolver lives alongside the
 * evaluator in ComplianceRuleEvaluator.ts; tests imported directly.
 */
import type {
  ActionClass,
  ActionTimeRuleContext,
  ComplianceBypassPolicy,
  ComplianceRule,
} from '@oweibo/core-contracts';
import { scopeBasedBypassResolver } from '../ComplianceRuleEvaluator.js';

function rule(bypassPolicy: ComplianceBypassPolicy): ComplianceRule {
  return {
    ruleId: 'r-1',
    title: 't',
    description: 'd',
    enforcementPhase: 'action_time',
    actionClasses: ['*'],
    severity: 'block',
    check: () => ({ kind: 'fire', details: {} }),
    remediation: 'r',
    bypassPolicy,
  };
}

function ctx(scopes?: readonly string[]): ActionTimeRuleContext {
  const out: ActionTimeRuleContext = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    actionClass: 'deploy.prod' as ActionClass,
    payload: {},
  };
  if (scopes) (out as { -readonly [k in keyof ActionTimeRuleContext]: ActionTimeRuleContext[k] }).principalScopes = scopes;
  return out;
}

describe('scopeBasedBypassResolver', () => {
  it('returns null when rule.bypassPolicy is never (even with admin scope)', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('never'),
      ctx: ctx(['compliance:bypass:platform_admin']),
    });
    expect(r).toBeNull();
  });

  it('returns null when principalScopes is undefined', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('tenant_admin'),
      ctx: ctx(undefined),
    });
    expect(r).toBeNull();
  });

  it('returns null when principalScopes is empty', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('tenant_admin'),
      ctx: ctx([]),
    });
    expect(r).toBeNull();
  });

  it('platform_admin_only: compliance:bypass:platform_admin → bypass', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('platform_admin_only'),
      ctx: ctx(['compliance:bypass:platform_admin']),
    });
    expect(r).toEqual({
      kind: 'platform_admin',
      principal: 'scope:compliance:bypass:platform_admin',
      reason: 'scope-based bypass',
    });
  });

  it('platform_admin_only: tenant_admin scope alone → null', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('platform_admin_only'),
      ctx: ctx(['compliance:bypass:tenant_admin']),
    });
    expect(r).toBeNull();
  });

  it('platform_admin_only: legacy platform:bypass:compliance → bypass', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('platform_admin_only'),
      ctx: ctx(['platform:bypass:compliance']),
    });
    expect(r?.kind).toBe('platform_admin');
  });

  it('tenant_admin: tenant_admin scope → bypass kind=tenant_admin', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('tenant_admin'),
      ctx: ctx(['compliance:bypass:tenant_admin']),
    });
    expect(r).toEqual({
      kind: 'tenant_admin',
      principal: 'scope:compliance:bypass:tenant_admin',
      reason: 'scope-based bypass',
    });
  });

  it('tenant_admin: platform_admin scope ALSO bypasses (nesting)', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('tenant_admin'),
      ctx: ctx(['compliance:bypass:platform_admin']),
    });
    expect(r?.kind).toBe('platform_admin');
  });

  it('tenant_admin: legacy platform:bypass:compliance → bypass kind=platform_admin', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('tenant_admin'),
      ctx: ctx(['platform:bypass:compliance']),
    });
    expect(r?.kind).toBe('platform_admin');
  });

  it('tenant_admin: unrelated scope → null', () => {
    const r = scopeBasedBypassResolver({
      rule: rule('tenant_admin'),
      ctx: ctx(['tasks:read', 'tasks:write']),
    });
    expect(r).toBeNull();
  });
});
