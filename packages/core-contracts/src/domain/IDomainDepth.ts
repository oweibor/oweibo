/**
 * D.8 (domain-depth): depth measurement contracts.
 *
 * Per-domain composite score (0..100) computed from coverage across
 * D.1 (ontology), D.2 (rubrics), D.3 (compliance), D.4 (connectors),
 * D.5 (SME pool). Targets are stored on `domain_catalog.depth_targets`
 * — small domains can score 100% when fully covered without being
 * penalised against larger ones.
 *
 * Maturity: `DomainCatalogEntry.maturity` is the load-bearing tier
 * (every behavioural gate reads it). `DomainDepthSnapshot.recommendedTier`
 * is an advisory hysteresis-stabilised recommendation derived from the
 * last 8 snapshots — surfaced alongside the catalog tier so an admin
 * can spot when computed and curated disagree.
 */
import type { DomainMaturity, DomainSlug } from './DomainSlug.js';

export interface OntologyCoverage {
  readonly glossaryEntryCount: number;
  readonly namedEntityCount: number;
  readonly terminologyRuleCount: number;
  readonly disambiguationRuleCount: number;
  /** Days until the pack's next scheduled review; negative when overdue. */
  readonly nextReviewDays: number;
}

export interface EvalCoverage {
  readonly rubricCount: number;
  readonly criterionCount: number;
  readonly criteriaWithDeterministicCheck: number;
  readonly criteriaWithLlmJudge: number;
  readonly criteriaWithSmeRequired: number;
}

export interface ComplianceCoverage {
  readonly rulePackCount: number;
  readonly ruleCount: number;
  readonly compliancePostures: readonly string[];
  readonly actionClassExtensions: readonly string[];
}

export interface ConnectorCoverage {
  readonly certifiedConnectorCount: {
    readonly experimental: number;
    readonly community: number;
    readonly verified: number;
    readonly enterprise: number;
  };
  readonly capabilityCount: number;
}

export interface SmeCoverage {
  readonly credentialedSmeCount: number;
  readonly weeklyReviewVolume: number;
  /** 0..1; defaults to 0 when no inter-rater data exists yet. */
  readonly meanInterRaterAgreement: number;
}

/**
 * Inputs the composite formula consumes. The metrics service assembles
 * these from the various registries + DB counters; tests synthesise
 * them directly.
 */
export interface DomainDepthInputs {
  readonly ontologyEntries: number;          // glossary + namedEntities (proxy for "ontology size")
  readonly rubricCount: number;
  readonly ruleCount: number;
  readonly verifiedConnectors: number;       // count at tier >= 'verified'
  readonly credentialedSmes: number;
  /**
   * Per-week activity score in [0,1] derived from weeklyReviewVolume +
   * regulatory-feed ingestion. Caller-supplied so the metrics service
   * doesn't have to know the exact telemetry shape.
   */
  readonly weeklyReviewActivityScore: number;
}

export interface DomainDepthSnapshot {
  readonly domainSlug: DomainSlug;
  readonly snapshotAt: string;
  readonly ontologyCoverage: OntologyCoverage;
  readonly evalCoverage: EvalCoverage;
  readonly complianceCoverage: ComplianceCoverage;
  readonly connectorCoverage: ConnectorCoverage;
  readonly smeCoverage: SmeCoverage;
  readonly compositeScore: number;
  /** Hysteresis-stabilised advisory tier. */
  readonly recommendedTier: DomainMaturity;
}

/**
 * Per-(tenant, domain) utilization snapshot. The composite ratio is a
 * coarse "is the tenant actually consuming the domain depth they're
 * bound to" signal. Informational; never load-bearing.
 */
export interface TenantDomainUtilizationSnapshot {
  readonly tenantId: string;
  readonly domainSlug: DomainSlug;
  readonly snapshotAt: string;
  readonly ontologyRecallCount: number;
  readonly rubricEvaluationCount: number;
  readonly complianceEvaluationCount: number;
  readonly utilizationRatio: number;
}
