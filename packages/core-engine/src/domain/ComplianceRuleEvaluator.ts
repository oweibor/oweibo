/**
 * D.3 (domain-depth): action-time compliance evaluator.
 *
 * Resolves applicable rules from the registry, runs each against the
 * action-time context, aggregates to a single worst-verdict. The trust
 * ladder treats:
 *   - 'block'  → return `forbidden { reason: <ruleId> }` immediately
 *   - 'warn'   → flow into the gate decision detail; no upgrade
 *   - 'info'   → audit-only
 *   - 'pass'   → no signal
 *
 * Bypass: when a rule is at severity='block' but its `bypassPolicy`
 * authorises the calling principal, the evaluator marks the verdict
 * as 'bypass' instead of 'block' and records the bypass principal +
 * reason on the result. The trust ladder treats 'bypass' as
 * non-blocking but the audit row preserves the override.
 *
 * Built-in deterministic check fns mirror those in
 * `DeterministicCheckExecutor` (D.2) but specialised for action
 * payloads — see DETERMINISTIC_FNS below.
 */
import type {
  ActionTimeRuleContext,
  ComplianceEvaluationOutcome,
  ComplianceRule,
  ComplianceRulePack,
  ComplianceRuleResult,
  ComplianceRuleVerdict,
  IComplianceRulePackRegistry,
  IComplianceRuleEvaluator,
} from '@oweibo/core-contracts';

export interface BypassAuthorization {
  /** 'platform_admin', 'tenant_admin', or absent. */
  readonly kind?: 'platform_admin' | 'tenant_admin';
  readonly principal: string;
  readonly reason: string;
}

export type BypassResolver = (input: {
  rule: ComplianceRule;
  ctx: ActionTimeRuleContext;
}) => Promise<BypassAuthorization | null> | BypassAuthorization | null;

export interface ComplianceRuleEvaluatorOptions {
  /** Optional bypass seam. Returns null when no bypass is authorised. */
  bypassResolver?: BypassResolver;
}

export class ComplianceRuleEvaluator implements IComplianceRuleEvaluator {
  private readonly bypassResolver: BypassResolver;

  constructor(
    private readonly registry: IComplianceRulePackRegistry,
    opts: ComplianceRuleEvaluatorOptions = {},
  ) {
    this.bypassResolver = opts.bypassResolver ?? (() => null);
  }

  async evaluateActionTime(ctx: ActionTimeRuleContext): Promise<ComplianceEvaluationOutcome> {
    const applicable = await this.registry.applicableRules(ctx.tenantId, 'action_time');
    const perRule: ComplianceRuleResult[] = [];
    for (const { rule, pack } of applicable) {
      if (!ruleAppliesToClass(rule, ctx.actionClass)) continue;
      const fired = runRule(rule, ctx);
      if (!fired) {
        perRule.push({
          ruleId: rule.ruleId,
          domainSlug: pack.domainSlug,
          packVersion: pack.packVersion,
          phase: 'action_time',
          verdict: 'pass',
          severity: rule.severity,
        });
        continue;
      }
      // Rule fired. Translate severity to verdict, honoring shadowMode +
      // bypass + bypassPolicy.
      let verdict: ComplianceRuleVerdict;
      let bypass: BypassAuthorization | null = null;
      if (rule.severity === 'block') {
        if (rule.shadowMode) {
          verdict = 'warn';
        } else if (rule.bypassPolicy !== 'never') {
          bypass = await this.bypassResolver({ rule, ctx });
          if (bypass && isAuthorised(rule.bypassPolicy, bypass.kind)) {
            verdict = 'bypass';
          } else {
            verdict = 'block';
          }
        } else {
          verdict = 'block';
        }
      } else {
        verdict = rule.severity;
      }
      perRule.push({
        ruleId: rule.ruleId,
        domainSlug: pack.domainSlug,
        packVersion: pack.packVersion,
        phase: 'action_time',
        verdict,
        severity: rule.severity,
        details: fired.details,
        ...(bypass && verdict === 'bypass'
          ? { bypassPrincipal: bypass.principal, bypassReason: bypass.reason }
          : {}),
      });
    }
    return { worstVerdict: worstOf(perRule), perRule };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function ruleAppliesToClass(rule: ComplianceRule, actionClass: string): boolean {
  for (const c of rule.appliesToActionClasses) {
    if (c === '*' || c === actionClass) return true;
  }
  return false;
}

interface FiredResult {
  readonly details?: unknown;
}

function runRule(rule: ComplianceRule, ctx: ActionTimeRuleContext): FiredResult | null {
  if (rule.check !== 'deterministic') {
    // Non-deterministic rules are not fired here — they're audit-only at
    // this seam. A deployment with an llm_judge executor would wire a
    // composed evaluator (see D.2 composeExecutors for the pattern).
    return null;
  }
  const cfg = (rule.checkConfig ?? {}) as Record<string, unknown>;
  const fn = typeof cfg['fn'] === 'string' ? (cfg['fn'] as string) : '';
  const checker = DETERMINISTIC_FNS[fn];
  if (!checker) return null;
  try {
    return checker(cfg, ctx);
  } catch {
    return null;
  }
}

function isAuthorised(
  policy: ComplianceRule['bypassPolicy'],
  kind?: BypassAuthorization['kind'],
): boolean {
  if (policy === 'never') return false;
  if (!kind) return false;
  if (policy === 'platform_admin_only') return kind === 'platform_admin';
  if (policy === 'tenant_admin') return kind === 'platform_admin' || kind === 'tenant_admin';
  return false;
}

function worstOf(results: readonly ComplianceRuleResult[]): ComplianceRuleVerdict {
  let worst: ComplianceRuleVerdict = 'pass';
  const order: Record<ComplianceRuleVerdict, number> = {
    pass: 0,
    info: 1,
    bypass: 2,
    warn: 3,
    block: 4,
  };
  for (const r of results) {
    if (order[r.verdict] > order[worst]) worst = r.verdict;
  }
  return worst;
}

// ─── Built-in deterministic check fns ───────────────────────────────────
//
// Each fn returns a FiredResult when the rule SHOULD fire (i.e., violation
// detected), or null when it should not fire.

type DeterministicCheckFn = (
  cfg: Record<string, unknown>,
  ctx: ActionTimeRuleContext,
) => FiredResult | null;

const DETERMINISTIC_FNS: Readonly<Record<string, DeterministicCheckFn>> = {
  // Fires when the regex pattern MATCHES any string in the payload.
  payloadRegexAbsent: (cfg, ctx) => {
    const pattern = stringOf(cfg, 'pattern');
    if (!pattern) return null;
    const re = new RegExp(pattern);
    const haystack = stringifyPayload(ctx.payload);
    if (re.test(haystack)) {
      return { details: { matched: true, pattern } };
    }
    return null;
  },

  // Fires when the named field is MISSING (or shorter than minLength).
  payloadFieldPresent: (cfg, ctx) => {
    const field = stringOf(cfg, 'field');
    if (!field) return null;
    const minLength = numberOf(cfg, 'minLength') ?? 0;
    const payload = ctx.payload as Record<string, unknown> | null | undefined;
    if (payload === null || typeof payload !== 'object') {
      return { details: { reason: 'payload_not_object', field } };
    }
    const value = payload[field];
    if (value === undefined || value === null) {
      return { details: { reason: 'missing', field } };
    }
    if (typeof value === 'string' && value.length < minLength) {
      return { details: { reason: 'too_short', field, length: value.length, minLength } };
    }
    if (Array.isArray(value) && value.length === 0) {
      return { details: { reason: 'empty_array', field } };
    }
    return null;
  },

  // Composite condition: privileged === true must imply waiverId present.
  payloadCondition: (cfg, ctx) => {
    const condition = stringOf(cfg, 'condition');
    const payload = ctx.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== 'object') return null;
    if (condition === 'privileged_implies_waiver') {
      if (payload['privileged'] === true) {
        const waiver = payload['waiverId'];
        if (typeof waiver !== 'string' || waiver.length === 0) {
          return { details: { reason: 'privileged_without_waiver' } };
        }
      }
      return null;
    }
    return null;
  },
};

function stringOf(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === 'string' ? v : undefined;
}

function numberOf(cfg: Record<string, unknown>, key: string): number | undefined {
  const v = cfg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function stringifyPayload(payload: unknown): string {
  try {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    return '';
  }
}
