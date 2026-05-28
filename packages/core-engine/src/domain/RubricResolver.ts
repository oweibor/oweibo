/**
 * D.2 (domain-depth): RubricResolver — resolves the applicable domain
 * rubric set for a given (tenantId, taskKind).
 *
 * The resolver consults:
 *   1. A tenant-domain lookup (injected): returns the slug list a
 *      tenant is bound to. In v1 the binding comes from
 *      `tenant_domain_intake.classified_domain`; once D.6 lands, the
 *      lookup queries `tenant_domain_binding` for multi-domain tenants.
 *   2. The `IDomainRubricRegistry`: filters by domain + task kind.
 *
 * Generic rubrics (compile, tests pass) are NOT modelled here — the
 * eval pipeline owns its generic rubric set; this resolver only returns
 * the *domain additions*. The caller composes the two when running the
 * evaluator.
 */
import type {
  DomainRubric,
  DomainSlug,
  IDomainRubricRegistry,
  IRubricResolver,
} from '@oweibo/core-contracts';

/**
 * Lookup that returns the domain slug(s) a tenant is bound to. In v1
 * this typically wraps a single SELECT against
 * `tenant_domain_intake.classified_domain` returning a 0- or 1-element
 * array; D.6 generalises to N-element returns.
 */
export type TenantDomainLookup = (tenantId: string) => Promise<readonly DomainSlug[]>;

export interface RubricResolverOptions {
  /** Default: returns []. Use to short-circuit unbound tenants in tests. */
  defaultDomains?: readonly DomainSlug[];
}

export class RubricResolver implements IRubricResolver {
  private readonly defaultDomains: readonly DomainSlug[];

  constructor(
    private readonly registry: IDomainRubricRegistry,
    private readonly tenantDomainLookup: TenantDomainLookup,
    opts: RubricResolverOptions = {},
  ) {
    this.defaultDomains = opts.defaultDomains ?? [];
  }

  async resolve(input: { tenantId: string; taskKind: string }): Promise<readonly DomainRubric[]> {
    let domains: readonly DomainSlug[];
    try {
      domains = await this.tenantDomainLookup(input.tenantId);
    } catch {
      // Lookup failure degrades to the default domain set rather than
      // throwing; rubric evaluation never blocks task completion.
      domains = this.defaultDomains;
    }
    if (domains.length === 0) domains = this.defaultDomains;

    const out: DomainRubric[] = [];
    const seen = new Set<string>();
    for (const slug of domains) {
      for (const rubric of this.registry.forDomainAndTaskKind(slug, input.taskKind)) {
        const key = `${rubric.domainSlug}:${rubric.rubricId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rubric);
      }
    }
    return out;
  }
}
