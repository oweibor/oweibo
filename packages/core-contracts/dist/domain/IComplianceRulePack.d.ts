/**
 * D.3 (domain-depth): per-domain compliance rule pack.
 *
 * A rule pack contributes both:
 *   - new action classes (e.g. `phi.read` for healthcare)
 *   - new rules that run at one of two enforcement surfaces:
 *       'action_time'   — inside IActionGate, against ActionContext
 *       'artifact_time' — inside ComplianceGate, against ArtifactBundle
 *
 * Domain rules NEVER loosen platform-wide rules (design principle 24).
 * They are additive: a rule's `block` short-circuits to a forbidden
 * gate decision; `warn` flows into the decision details; `info` is
 * audit-only.
 *
 * Multi-domain tenants (D.6): when a tenant binds to multiple domains,
 * ALL applicable rule packs apply. There is no "dominant domain" —
 * strictness composes.
 */
import type { ActionClass, ExtendedActionClassDeclaration } from '../action/ActionClass.js';
import type { DomainSlug } from './DomainSlug.js';
export type { ActionClass };
export type ComplianceEnforcementPhase = 'action_time' | 'artifact_time';
export type ComplianceCheckKind = 'deterministic' | 'llm_judge' | 'sme_required';
export type ComplianceSeverity = 'info' | 'warn' | 'block';
/**
 * Who, if anyone, can bypass a rule.
 *   - 'never'                — only a pack version update unblocks
 *   - 'platform_admin_only'  — platform admin with audit row
 *   - 'tenant_admin'         — tenant admin with audit row
 */
export type ComplianceBypassPolicy = 'never' | 'platform_admin_only' | 'tenant_admin';
export interface ComplianceRule {
    readonly ruleId: string;
    readonly title: string;
    readonly description: string;
    readonly enforcementPhase: ComplianceEnforcementPhase;
    /**
     * Action classes this rule applies to. `'*'` wildcard matches all.
     * Ignored for artifact_time rules — those match by artifact-bundle
     * shape rather than action class.
     *
     * Typed as `string` rather than `ActionClass` so a rule pack can
     * declare extended classes that are registered by its own
     * `actionClassExtensions` array — those slugs are not yet branded as
     * `ExtendedActionClass` at the time the pack literal is constructed.
     * The evaluator matches by string equality so the brand isn't
     * load-bearing here.
     */
    readonly appliesToActionClasses: readonly string[];
    readonly check: ComplianceCheckKind;
    /** Opaque to the contract; consumed by the matching executor. */
    readonly checkConfig: unknown;
    readonly severity: ComplianceSeverity;
    /** Operator-facing remediation guidance; surfaced in the gate decision details. */
    readonly remediation: string;
    readonly bypassPolicy: ComplianceBypassPolicy;
    /** When true, the rule does not block — it logs to audit only. Useful for shadow-mode rollouts. */
    readonly shadowMode?: boolean;
}
export interface ComplianceRulePackMetadata {
    readonly authoredBy: string;
    readonly reviewedBy: readonly string[];
    readonly authoredAt: string;
    /** D.7 currency hook — when this pack should be re-validated. */
    readonly nextReviewDue: string;
    readonly regulatoryRefs: readonly {
        readonly framework: string;
        readonly section: string;
        readonly url?: string;
    }[];
}
export interface ComplianceRulePack {
    readonly domainSlug: DomainSlug;
    readonly packVersion: string;
    /** e.g. ['HIPAA'], ['PCI-DSS','SOC2']. */
    readonly compliancePostures: readonly string[];
    readonly rules: readonly ComplianceRule[];
    /** Action classes this pack adds to the runtime taxonomy. */
    readonly actionClassExtensions: readonly ExtendedActionClassDeclaration[];
    readonly metadata: ComplianceRulePackMetadata;
}
/**
 * The output of evaluating a single rule against a context.
 *   - 'pass'   — rule did not fire
 *   - 'info'   — rule fired at info severity; audit-only
 *   - 'warn'   — rule fired at warn severity; decision detail
 *   - 'block'  — rule fired at block severity; short-circuits gate
 *   - 'bypass' — rule fired at block severity but was bypassed by an
 *                authorised principal; recorded for audit
 */
export type ComplianceRuleVerdict = 'pass' | 'info' | 'warn' | 'block' | 'bypass';
export interface ComplianceRuleResult {
    readonly ruleId: string;
    readonly domainSlug?: DomainSlug;
    readonly packVersion: string;
    readonly phase: ComplianceEnforcementPhase;
    readonly verdict: ComplianceRuleVerdict;
    readonly severity: ComplianceSeverity;
    readonly details?: unknown;
    readonly bypassPrincipal?: string;
    readonly bypassReason?: string;
}
/**
 * Aggregate outcome of evaluating all applicable rules at a single surface.
 * `worstVerdict` is the union signal the gate acts on: any 'block' result
 * makes worstVerdict='block'; otherwise highest fired severity wins.
 */
export interface ComplianceEvaluationOutcome {
    readonly worstVerdict: ComplianceRuleVerdict;
    readonly perRule: readonly ComplianceRuleResult[];
}
export interface IComplianceRulePackRegistry {
    /** All packs known at registry-construction time. */
    list(): readonly ComplianceRulePack[];
    /** Packs whose `domainSlug` is in `domains`. */
    forDomains(domains: readonly DomainSlug[]): readonly ComplianceRulePack[];
    /**
     * Resolve the applicable rules for a tenant + phase. The implementation
     * consults the tenant's bound domains via the supplied lookup (in v1
     * this wraps `tenant_domain_intake.classified_domain`; D.6 generalises).
     *
     * Returns flattened rules paired with their pack so the evaluator can
     * tag results with packVersion + domainSlug.
     */
    applicableRules(tenantId: string, phase: ComplianceEnforcementPhase): Promise<readonly {
        readonly rule: ComplianceRule;
        readonly pack: ComplianceRulePack;
    }[]>;
}
/**
 * Context passed to action-time rule executors. Mirrors the shape of
 * `ActionContext` (so executors can pattern-match against payload + action
 * class) without importing the heavier core-engine types.
 */
export interface ActionTimeRuleContext {
    readonly tenantId: string;
    readonly actionClass: ActionClass;
    readonly payload: unknown;
    readonly summary?: string;
}
export interface IComplianceRuleEvaluator {
    /**
     * Evaluate every applicable action-time rule for the tenant against
     * the supplied action context. Returns the aggregate outcome plus
     * per-rule results (for audit logging).
     */
    evaluateActionTime(ctx: ActionTimeRuleContext): Promise<ComplianceEvaluationOutcome>;
}
//# sourceMappingURL=IComplianceRulePack.d.ts.map