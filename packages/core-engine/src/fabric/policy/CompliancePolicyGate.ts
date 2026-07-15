/**
 * ADR-006 §3.2 — the storage-layer compliance gate (INV-4).
 *
 * Every fabric write of source-derived content MUST traverse this gate. The
 * gate is deliberately a PURE function of (policy, candidate write): it takes
 * no planner, no plan, no ranking input, and has no way to reach one. That is
 * the whole guarantee — "enforced at the storage layer independently of the
 * planner" (§18.3) is only true if the planner cannot influence the verdict,
 * and the cheapest way to guarantee that is to make it structurally impossible.
 *
 * There is NO soft mode. §18.3: "block, log, alert. Never pass-through." Soft
 * compliance is non-compliance with telemetry.
 */
import {
  POLICY_DEFAULTS,
  type PolicyDimension,
  type PolicyValue,
} from './contract.js';

/** The write the gate adjudicates — source-derived content bound for a fabric store. */
export interface CandidateWrite {
  readonly tenantId: string;
  readonly connectorId: string;
  /** Classification tags carried by the source document (§18.2 exclusions). */
  readonly tags?: readonly string[];
  /** The region this write would land in — checked against provisioning (§18.3). */
  readonly targetRegion?: string;
  /** True when the write persists content bodies (vs. metadata only). */
  readonly persistsContent?: boolean;
  /** True when the write embeds full content into the vector store (K.5 scope). */
  readonly embedsFullContent?: boolean;
}

export type ComplianceVerdict =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'block';
      /** The dimension that blocked — for the audit row and the alert. */
      readonly dimension: PolicyDimension;
      readonly reason: string;
    };

/** A tenant's effective compliance policy, dimension → value. */
export type EffectivePolicy = Partial<Readonly<Record<PolicyDimension, PolicyValue>>>;

function valueOf<K extends PolicyDimension>(
  policy: EffectivePolicy,
  dimension: K,
): Extract<PolicyValue, { kind: K }> {
  return (policy[dimension] ?? POLICY_DEFAULTS[dimension]) as Extract<PolicyValue, { kind: K }>;
}

/**
 * ADR-006 §3.2 — adjudicate one write. Order is deliberate: the checks run
 * cheapest-first, but every check is total — the first block wins and the
 * dimension is named, because a block that cannot say WHICH rule fired is not
 * auditable (§18.3 "block, log, alert").
 */
export function evaluateCompliance(
  policy: EffectivePolicy,
  write: CandidateWrite,
  /** The tenant's provisioned region (§18.3: residency is provisioning + storage block). */
  provisionedRegion?: string,
): ComplianceVerdict {
  // 1. Connector enablement — a disabled connector is ABSENT, not deprioritized
  //    (§18.2). Enforced here so a disabled connector cannot write even if some
  //    caller negotiated it by mistake.
  const enablement = valueOf(policy, 'connector_enablement');
  if (enablement.enabled[write.connectorId] === false) {
    return {
      kind: 'block',
      dimension: 'connector_enablement',
      reason: `connector ${write.connectorId} is disabled by tenant policy`,
    };
  }

  // 2. Data persistence — may we persist copies of external content at all?
  const persistence = valueOf(policy, 'data_persistence');
  if (!persistence.allowed && write.persistsContent === true) {
    return {
      kind: 'block',
      dimension: 'data_persistence',
      reason: 'tenant policy forbids persisting external content',
    };
  }

  // 3. Indexing scope — full-content embedding is opt-in (K.5's default, subsumed).
  const scope = valueOf(policy, 'indexing_scope');
  if (scope.scope === 'metadata' && write.embedsFullContent === true) {
    return {
      kind: 'block',
      dimension: 'indexing_scope',
      reason: 'indexing scope is metadata-only; full-content embedding not permitted',
    };
  }

  // 4. Classification exclusions — "never index documents tagged Confidential".
  const exclusions = valueOf(policy, 'classification_exclusions');
  if (exclusions.excludeTags.length > 0 && write.tags && write.tags.length > 0) {
    const hit = write.tags.find((t) => exclusions.excludeTags.includes(t));
    if (hit !== undefined) {
      return {
        kind: 'block',
        dimension: 'classification_exclusions',
        reason: `document carries excluded classification tag "${hit}"`,
      };
    }
  }

  // 5. Residency — checked against the tenant's PROVISIONED region, never ranked
  //    or optimized (§18.3 l.1629: "a provisioning constraint plus a storage-layer
  //    block — never a planner hint").
  const residency = valueOf(policy, 'data_residency');
  const requiredRegion = residency.region || provisionedRegion;
  if (requiredRegion && write.targetRegion && write.targetRegion !== requiredRegion) {
    return {
      kind: 'block',
      dimension: 'data_residency',
      reason: `write targets region ${write.targetRegion}; tenant is pinned to ${requiredRegion}`,
    };
  }

  return { kind: 'allow' };
}

export interface ComplianceAuditSink {
  /** §18.3 — a block is logged AND alerted. Never silently dropped. */
  recordBlock(args: {
    readonly tenantId: string;
    readonly connectorId: string;
    readonly dimension: PolicyDimension;
    readonly reason: string;
  }): Promise<void>;
}

/**
 * The gate as the write path calls it. Returns the verdict and, on block,
 * records the audit row before returning — so a blocked write is never
 * invisible. A blocked write MUST NOT be silently dropped: silence is
 * indistinguishable from "no such document", which is how a compliance
 * failure becomes undetectable (§3.2 rule 2).
 */
export class CompliancePolicyGate {
  constructor(
    private readonly loadPolicy: (tenantId: string) => Promise<EffectivePolicy>,
    private readonly audit?: ComplianceAuditSink,
    private readonly provisionedRegionOf?: (tenantId: string) => Promise<string | undefined>,
  ) {}

  async check(write: CandidateWrite): Promise<ComplianceVerdict> {
    const policy = await this.loadPolicy(write.tenantId);
    const region = await this.provisionedRegionOf?.(write.tenantId);
    const verdict = evaluateCompliance(policy, write, region);
    if (verdict.kind === 'block') {
      await this.audit?.recordBlock({
        tenantId: write.tenantId,
        connectorId: write.connectorId,
        dimension: verdict.dimension,
        reason: verdict.reason,
      });
    }
    return verdict;
  }
}
