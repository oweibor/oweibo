/**
 * D.3 (domain-depth): bundled implementation of
 * `IComplianceRulePackRegistry`.
 *
 * Aggregates the v1 rule packs and registers each pack's
 * `actionClassExtensions` with the supplied
 * `ActionClassExtensionRegistry`. Registration is one-way; a deployment
 * that needs to retire a class restarts the platform with the pack
 * removed.
 *
 * `applicableRules()` consults the supplied `TenantDomainLookup` to
 * resolve the tenant's bound domain(s) and returns the matching rules
 * paired with their pack (so evaluators can audit packVersion).
 */
import type {
  ComplianceEnforcementPhase,
  ComplianceRule,
  ComplianceRulePack,
  DomainSlug,
  IActionClassExtensionRegistry,
  IComplianceRulePackRegistry,
} from '@oweibo/core-contracts';
import { fintechCompliancePack } from './rule-packs/fintech.compliance.js';
import { healthcareCompliancePack } from './rule-packs/healthcare.compliance.js';
import { legalCompliancePack } from './rule-packs/legal.compliance.js';

export const V1_COMPLIANCE_RULE_PACKS: readonly ComplianceRulePack[] = [
  fintechCompliancePack,
  healthcareCompliancePack,
  legalCompliancePack,
];

/**
 * Lookup that returns the domain slug(s) a tenant is bound to. Re-uses
 * the seam introduced for RubricResolver — see D.2.
 */
export type TenantDomainLookup = (tenantId: string) => Promise<readonly DomainSlug[]>;

export interface ComplianceRulePackRegistryOptions {
  /**
   * When supplied, every pack's `actionClassExtensions` are registered
   * at construction time. Required for the trust-ladder integration to
   * resolve extended action classes; tests that only exercise the
   * registry can omit it.
   */
  actionClassExtensionRegistry?: IActionClassExtensionRegistry;
  /** Default tenant domain lookup: returns [] (no rules apply). */
  tenantDomainLookup?: TenantDomainLookup;
  /** Fallback when the lookup returns [] / throws. */
  defaultDomains?: readonly DomainSlug[];
}

export class ComplianceRulePackRegistry implements IComplianceRulePackRegistry {
  private readonly packs: readonly ComplianceRulePack[];
  private readonly bySlug: ReadonlyMap<string, ComplianceRulePack>;
  private readonly lookup: TenantDomainLookup;
  private readonly defaultDomains: readonly DomainSlug[];

  constructor(
    packs: readonly ComplianceRulePack[] = V1_COMPLIANCE_RULE_PACKS,
    opts: ComplianceRulePackRegistryOptions = {},
  ) {
    const map = new Map<string, ComplianceRulePack>();
    for (const pack of packs) {
      if (map.has(pack.domainSlug)) {
        throw new Error(
          `ComplianceRulePackRegistry: duplicate pack for domain ${JSON.stringify(pack.domainSlug)}`,
        );
      }
      map.set(pack.domainSlug, pack);
      if (opts.actionClassExtensionRegistry) {
        for (const decl of pack.actionClassExtensions) {
          opts.actionClassExtensionRegistry.register(decl);
        }
      }
    }
    this.packs = [...packs].sort((a, b) => a.domainSlug.localeCompare(b.domainSlug));
    this.bySlug = map;
    this.lookup = opts.tenantDomainLookup ?? (async () => []);
    this.defaultDomains = opts.defaultDomains ?? [];
  }

  list(): readonly ComplianceRulePack[] {
    return this.packs;
  }

  forDomains(domains: readonly DomainSlug[]): readonly ComplianceRulePack[] {
    const out: ComplianceRulePack[] = [];
    const seen = new Set<string>();
    for (const d of domains) {
      const pack = this.bySlug.get(d);
      if (pack && !seen.has(pack.domainSlug)) {
        seen.add(pack.domainSlug);
        out.push(pack);
      }
    }
    return out;
  }

  async applicableRules(
    tenantId: string,
    phase: ComplianceEnforcementPhase,
  ): Promise<readonly { readonly rule: ComplianceRule; readonly pack: ComplianceRulePack }[]> {
    let domains: readonly DomainSlug[];
    try {
      domains = await this.lookup(tenantId);
    } catch {
      domains = this.defaultDomains;
    }
    if (domains.length === 0) domains = this.defaultDomains;

    const out: { rule: ComplianceRule; pack: ComplianceRulePack }[] = [];
    for (const pack of this.forDomains(domains)) {
      for (const rule of pack.rules) {
        if (rule.enforcementPhase !== phase) continue;
        out.push({ rule, pack });
      }
    }
    return out;
  }
}
