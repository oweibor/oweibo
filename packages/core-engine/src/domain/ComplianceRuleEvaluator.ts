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
  /**
   * Asserted by the resolver. The resolver IS the trust boundary — it must
   * validate that the calling principal actually has this authority before
   * returning a non-null result. The evaluator only checks that the asserted
   * kind is compatible with the rule's bypassPolicy; it cannot independently
   * verify the principal.
   */
  readonly kind?: 'platform_admin' | 'tenant_admin';
  readonly principal: string;
  readonly reason: string;
}

export type BypassResolver = (input: {
  rule: ComplianceRule;
  ctx: ActionTimeRuleContext;
}) => Promise<BypassAuthorization | null> | BypassAuthorization | null;

/**
 * F.2.5: default scope-based bypass resolver.
 *
 * Maps `rule.bypassPolicy` to a scope string and checks the caller's
 * `ctx.principalScopes`. When the principal carries the scope, returns
 * a BypassAuthorization with the principal name. When the scope is
 * absent, OR when `ctx.principalScopes` itself is undefined, returns
 * null — the rule fires normally. The principal-name field uses
 * `ctx.principalScopes` as a witness; a real auth middleware threading
 * scopes should also surface a stable principal subject string (added
 * to BypassAuthorization here for audit).
 *
 * Scope shape:
 *   compliance:bypass:platform_admin   → bypasses 'platform_admin_only' rules
 *   compliance:bypass:tenant_admin     → bypasses 'tenant_admin' rules
 *                                        (and 'platform_admin_only' too — admin scopes nest)
 *   platform:bypass:compliance         → super-bypass (legacy, equivalent to platform_admin)
 */
export function scopeBasedBypassResolver(
  input: { rule: ComplianceRule; ctx: ActionTimeRuleContext },
): BypassAuthorization | null {
  if (input.rule.bypassPolicy === 'never') return null;
  const scopes = input.ctx.principalScopes;
  if (!scopes || scopes.length === 0) return null;

  const has = (s: string) => scopes.includes(s);

  if (input.rule.bypassPolicy === 'platform_admin_only') {
    if (has('compliance:bypass:platform_admin') || has('platform:bypass:compliance')) {
      return {
        kind: 'platform_admin',
        principal: 'scope:compliance:bypass:platform_admin',
        reason: 'scope-based bypass',
      };
    }
    return null;
  }
  if (input.rule.bypassPolicy === 'tenant_admin') {
    if (
      has('compliance:bypass:tenant_admin') ||
      has('compliance:bypass:platform_admin') ||
      has('platform:bypass:compliance')
    ) {
      const isPlatform = has('compliance:bypass:platform_admin') || has('platform:bypass:compliance');
      return {
        kind: isPlatform ? 'platform_admin' : 'tenant_admin',
        principal: isPlatform
          ? 'scope:compliance:bypass:platform_admin'
          : 'scope:compliance:bypass:tenant_admin',
        reason: 'scope-based bypass',
      };
    }
    return null;
  }
  return null;
}

export interface IComplianceEvaluatorLogger {
  warn(message: string, extra?: Record<string, unknown>): void;
}

export interface ComplianceRuleEvaluatorOptions {
  /** Optional bypass seam. Returns null when no bypass is authorised. */
  bypassResolver?: BypassResolver;
  /** Observability sink for evaluator-internal anomalies. */
  log?: IComplianceEvaluatorLogger;
}

export class ComplianceRuleEvaluator implements IComplianceRuleEvaluator {
  private readonly bypassResolver: BypassResolver;
  private readonly log: IComplianceEvaluatorLogger;

  constructor(
    private readonly registry: IComplianceRulePackRegistry,
    opts: ComplianceRuleEvaluatorOptions = {},
  ) {
    // F.2.5: default to the scope-based resolver instead of "always null".
    // Callers that need custom bypass semantics still inject their own.
    // The scope resolver is itself default-deny when ctx.principalScopes
    // is undefined, so the byte-identical-to-old behaviour holds for any
    // existing test / caller that doesn't supply scopes.
    this.bypassResolver = opts.bypassResolver ?? scopeBasedBypassResolver;
    this.log = opts.log ?? {
      warn: (message, extra) => console.warn(`[ComplianceRuleEvaluator] ${message}`, extra ?? {}),
    };
  }

  async evaluateActionTime(ctx: ActionTimeRuleContext): Promise<ComplianceEvaluationOutcome> {
    const applicable = await this.registry.applicableRules(ctx.tenantId, 'action_time');
    const perRule: ComplianceRuleResult[] = [];
    for (const { rule, pack } of applicable) {
      if (!ruleAppliesToClass(rule, ctx.actionClass)) continue;
      const evaluated = runRule(rule, ctx);
      if (evaluated.kind === 'error') {
        // Audit-fix: a thrown check used to be swallowed and treated as
        // pass. Treat it as fail-closed (block) for block-severity rules
        // so a buggy check cannot let an unsafe action through, and log
        // for operator visibility. Lower-severity rules surface as warn.
        const verdict: ComplianceRuleVerdict = rule.severity === 'block' ? 'block' : 'warn';
        this.log.warn(`compliance rule check threw`, {
          ruleId: rule.ruleId,
          domainSlug: pack.domainSlug,
          packVersion: pack.packVersion,
          actionClass: ctx.actionClass,
          tenantId: ctx.tenantId,
          error: evaluated.error,
        });
        perRule.push({
          ruleId: rule.ruleId,
          domainSlug: pack.domainSlug,
          packVersion: pack.packVersion,
          phase: 'action_time',
          verdict,
          severity: rule.severity,
          details: { error: evaluated.error, reason: 'rule_check_threw' },
        });
        continue;
      }
      if (evaluated.kind === 'no_fire') {
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
            // A resolver that returns a kind incompatible with the
            // bypassPolicy is a config bug — surface it so it doesn't
            // silently degrade to 'block'.
            if (bypass) {
              this.log.warn(`bypass kind mismatched bypassPolicy`, {
                ruleId: rule.ruleId,
                bypassPolicy: rule.bypassPolicy,
                returnedKind: bypass.kind ?? null,
                principal: bypass.principal,
              });
            }
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
        details: evaluated.fired.details,
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

type RuleEvaluation =
  | { kind: 'no_fire' }
  | { kind: 'fired'; fired: FiredResult }
  | { kind: 'error'; error: string };

function runRule(rule: ComplianceRule, ctx: ActionTimeRuleContext): RuleEvaluation {
  if (rule.check !== 'deterministic') {
    // Non-deterministic rules are not fired here — they're audit-only at
    // this seam. A deployment with an llm_judge executor would wire a
    // composed evaluator (see D.2 composeExecutors for the pattern).
    return { kind: 'no_fire' };
  }
  const cfg = (rule.checkConfig ?? {}) as Record<string, unknown>;
  const fn = typeof cfg['fn'] === 'string' ? (cfg['fn'] as string) : '';
  const checker = DETERMINISTIC_FNS[fn];
  if (!checker) return { kind: 'no_fire' };
  try {
    const out = checker(cfg, ctx);
    if (out === null) return { kind: 'no_fire' };
    return { kind: 'fired', fired: out };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
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

// Defensive limits to keep tenant- or domain-author-supplied regexes from
// becoming a ReDoS vector. The cache is bounded so a long sequence of
// distinct patterns can't grow it without bound.
const REGEX_PATTERN_MAX_LEN = 512;
const REGEX_HAYSTACK_MAX_LEN = 64 * 1024;
const REGEX_CACHE_MAX = 256;
const regexCache = new Map<string, RegExp | null>();

function compileRegex(pattern: string): RegExp | null {
  if (pattern.length > REGEX_PATTERN_MAX_LEN) return null;
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let re: RegExp | null;
  try {
    re = new RegExp(pattern);
  } catch {
    re = null;
  }
  // LRU-lite: drop oldest entry when over cap.
  if (regexCache.size >= REGEX_CACHE_MAX) {
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) regexCache.delete(oldest);
  }
  regexCache.set(pattern, re);
  return re;
}

const DETERMINISTIC_FNS: Readonly<Record<string, DeterministicCheckFn>> = {
  // Fires when the regex pattern MATCHES any string in the payload.
  payloadRegexAbsent: (cfg, ctx) => {
    const pattern = stringOf(cfg, 'pattern');
    if (!pattern) return null;
    const re = compileRegex(pattern);
    if (!re) return null;
    let haystack = stringifyPayload(ctx.payload);
    if (haystack.length > REGEX_HAYSTACK_MAX_LEN) {
      haystack = haystack.slice(0, REGEX_HAYSTACK_MAX_LEN);
    }
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
