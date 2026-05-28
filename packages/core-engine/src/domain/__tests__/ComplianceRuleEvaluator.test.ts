/**
 * D.3 — ComplianceRuleEvaluator tests.
 */
import type {
  ActionTimeRuleContext,
  ComplianceRule,
  ComplianceRulePack,
  IComplianceRulePackRegistry,
} from '@oweibo/core-contracts';
import { ComplianceRuleEvaluator } from '../ComplianceRuleEvaluator.js';

const packStub: ComplianceRulePack = {
  domainSlug: 'fintech',
  packVersion: '1.0.0-stub',
  compliancePostures: [],
  actionClassExtensions: [],
  rules: [],
  metadata: {
    authoredBy: 't',
    reviewedBy: [],
    authoredAt: '2026-05-28',
    nextReviewDue: '2026-11-28',
    regulatoryRefs: [],
  },
};

function registryWith(rules: readonly ComplianceRule[]): IComplianceRulePackRegistry {
  return {
    list: () => [packStub],
    forDomains: () => [packStub],
    applicableRules: async () => rules.map((r) => ({ rule: r, pack: packStub })),
  };
}

const ctx = (overrides: Partial<ActionTimeRuleContext> = {}): ActionTimeRuleContext => ({
  tenantId: 't1',
  actionClass: 'write.tenant_db.prod',
  payload: {},
  ...overrides,
});

describe('ComplianceRuleEvaluator — action-time', () => {
  it('returns pass when no rules apply to the action class', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'r1',
          title: 'r1',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['phi.read'],
          check: 'deterministic',
          checkConfig: { fn: 'payloadRegexAbsent', pattern: 'evil' },
          severity: 'block',
          remediation: '',
          bypassPolicy: 'never',
        },
      ]),
    );
    const out = await evalr.evaluateActionTime(
      ctx({ actionClass: 'read.tenant_db', payload: { x: 'evil' } }),
    );
    expect(out.worstVerdict).toBe('pass');
  });

  it('payloadRegexAbsent fires when pattern matches → block', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'no-pan',
          title: 'no PAN in payload',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['*'],
          check: 'deterministic',
          checkConfig: { fn: 'payloadRegexAbsent', pattern: '\\b\\d{13,19}\\b' },
          severity: 'block',
          remediation: '',
          bypassPolicy: 'never',
        },
      ]),
    );
    const out = await evalr.evaluateActionTime(ctx({ payload: { pan: '4111111111111111' } }));
    expect(out.worstVerdict).toBe('block');
    expect(out.perRule[0]!.verdict).toBe('block');
  });

  it('payloadFieldPresent fires when field missing → block with details', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'need-purpose',
          title: 'need purpose',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['*'],
          check: 'deterministic',
          checkConfig: { fn: 'payloadFieldPresent', field: 'purpose', minLength: 10 },
          severity: 'block',
          remediation: '',
          bypassPolicy: 'never',
        },
      ]),
    );
    const out = await evalr.evaluateActionTime(ctx({ payload: {} }));
    expect(out.worstVerdict).toBe('block');

    const okOut = await evalr.evaluateActionTime(
      ctx({ payload: { purpose: 'audit investigation' } }),
    );
    expect(okOut.worstVerdict).toBe('pass');
  });

  it('payloadCondition privileged_implies_waiver fires when waiver missing', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'priv-waiver',
          title: 'priv',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['*'],
          check: 'deterministic',
          checkConfig: { fn: 'payloadCondition', condition: 'privileged_implies_waiver' },
          severity: 'block',
          remediation: '',
          bypassPolicy: 'never',
        },
      ]),
    );
    const fire = await evalr.evaluateActionTime(ctx({ payload: { privileged: true } }));
    expect(fire.worstVerdict).toBe('block');

    const ok = await evalr.evaluateActionTime(ctx({ payload: { privileged: false } }));
    expect(ok.worstVerdict).toBe('pass');

    const okWaiver = await evalr.evaluateActionTime(
      ctx({ payload: { privileged: true, waiverId: 'w-123' } }),
    );
    expect(okWaiver.worstVerdict).toBe('pass');
  });

  it('shadowMode downgrades block to warn', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'shadow-r',
          title: 'shadow',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['*'],
          check: 'deterministic',
          checkConfig: { fn: 'payloadRegexAbsent', pattern: 'evil' },
          severity: 'block',
          shadowMode: true,
          remediation: '',
          bypassPolicy: 'never',
        },
      ]),
    );
    const out = await evalr.evaluateActionTime(ctx({ payload: { msg: 'evil' } }));
    expect(out.worstVerdict).toBe('warn');
  });

  it('authorised bypass downgrades block → bypass with audit info', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'bypass-r',
          title: 'bypass',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['*'],
          check: 'deterministic',
          checkConfig: { fn: 'payloadRegexAbsent', pattern: 'evil' },
          severity: 'block',
          remediation: '',
          bypassPolicy: 'platform_admin_only',
        },
      ]),
      {
        bypassResolver: () => ({
          kind: 'platform_admin',
          principal: 'admin-1',
          reason: 'incident-response',
        }),
      },
    );
    const out = await evalr.evaluateActionTime(ctx({ payload: { msg: 'evil' } }));
    expect(out.worstVerdict).toBe('bypass');
    expect(out.perRule[0]!.bypassPrincipal).toBe('admin-1');
    expect(out.perRule[0]!.bypassReason).toBe('incident-response');
  });

  it('tenant_admin bypass policy refuses an agent bypass (no kind supplied)', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'bypass-r',
          title: 'bypass',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['*'],
          check: 'deterministic',
          checkConfig: { fn: 'payloadRegexAbsent', pattern: 'evil' },
          severity: 'block',
          remediation: '',
          bypassPolicy: 'tenant_admin',
        },
      ]),
      {
        bypassResolver: () => ({ principal: 'agent-1', reason: 'auto' }),
      },
    );
    const out = await evalr.evaluateActionTime(ctx({ payload: { msg: 'evil' } }));
    // Without an explicit `kind`, bypass is not authorised; verdict stays block.
    expect(out.worstVerdict).toBe('block');
  });

  it('rule with non-deterministic check kind is skipped (no fire, no block)', async () => {
    const evalr = new ComplianceRuleEvaluator(
      registryWith([
        {
          ruleId: 'llm-r',
          title: '',
          description: '',
          enforcementPhase: 'action_time',
          appliesToActionClasses: ['*'],
          check: 'llm_judge',
          checkConfig: { judgePrompt: '...' },
          severity: 'block',
          remediation: '',
          bypassPolicy: 'never',
        },
      ]),
    );
    const out = await evalr.evaluateActionTime(ctx({ payload: { msg: 'bad' } }));
    expect(out.worstVerdict).toBe('pass');
  });
});
