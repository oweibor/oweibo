/**
 * D.6 (domain-depth): multi-domain tenant binding.
 *
 * A tenant can bind to N domains. One binding may carry role='primary';
 * any number of secondary bindings are allowed. Weights are advisory
 * — they inform conflict resolution (ontology disambiguation) and
 * ranking, not access control. Compliance posture is always strictness-
 * wins regardless of weights.
 *
 * Contract pairs with TenantDomainLookup (re-exported below) — the
 * existing seam used by D.2 RubricResolver and D.3
 * ComplianceRulePackRegistry to discover a tenant's domain set.
 * `TenantDomainBindingService.lookupForResolver()` returns that
 * callback bound to the service so consumers don't have to know about
 * normalization or row mapping.
 */
import type { DomainSlug } from './DomainSlug.js';

export type TenantDomainBindingRole = 'primary' | 'secondary';

export type TenantDomainBindingSource = 'classifier' | 'admin' | 'sme';

export interface TenantDomainBinding {
  readonly tenantId: string;
  readonly domainSlug: DomainSlug;
  readonly role: TenantDomainBindingRole;
  /**
   * Normalized at read time so weights across a tenant's bindings sum
   * to 1.0 (when at least one binding is present). The raw DB value
   * may not sum to 1.0; this contract surface always returns the
   * normalised form for consumers.
   */
  readonly weight: number;
  /** Raw (un-normalised) weight from the DB; useful for admin UIs. */
  readonly rawWeight: number;
  readonly boundBy: {
    readonly type: TenantDomainBindingSource;
    readonly id: string;
  };
  /** Classifier confidence at bind time; null for admin/sme bindings. */
  readonly confidence: number | null;
  readonly boundAt: string;
}

export interface TenantDomainBindingInput {
  readonly domainSlug: DomainSlug;
  readonly role: TenantDomainBindingRole;
  readonly rawWeight: number;
  readonly boundBy: {
    readonly type: TenantDomainBindingSource;
    readonly id: string;
  };
  readonly confidence?: number;
}

/**
 * Soft cap on bindings per tenant. Above this, `replaceBindings`
 * requires the `force` flag — the admin-web UI surfaces a confirmation
 * dialog rather than silently allowing a 10-domain tenant.
 */
export const TENANT_DOMAIN_BINDING_SOFT_CAP = 3;
