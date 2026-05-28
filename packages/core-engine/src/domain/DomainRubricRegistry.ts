/**
 * D.2 (domain-depth): bundled rubric registry.
 *
 * Aggregates all per-domain rubric stubs. The default constructor loads
 * `V1_DOMAIN_RUBRICS`; tests construct their own slice via the
 * single-arg form. The registry is immutable after construction;
 * additions land via new rubric files + an entry in
 * `V1_DOMAIN_RUBRICS`.
 */
import type {
  DomainRubric,
  DomainSlug,
  IDomainRubricRegistry,
} from '@oweibo/core-contracts';
import {
  fintechAuditTrailRubric,
  fintechDecimalPrecisionRubric,
  fintechIdempotencyRubric,
} from './rubrics/fintech.rubric.js';
import {
  healthcareMinimumNecessaryRubric,
  healthcarePhiRedactionRubric,
} from './rubrics/healthcare.rubric.js';
import {
  legalCitationAccuracyRubric,
  legalPrivilegePreservationRubric,
} from './rubrics/legal.rubric.js';
import {
  mlResearchDatasetProvenanceRubric,
  mlResearchReproducibilityRubric,
} from './rubrics/ml-research.rubric.js';
import {
  devopsObservabilityRubric,
  devopsRollbackStrategyRubric,
} from './rubrics/devops.rubric.js';

export const V1_DOMAIN_RUBRICS: readonly DomainRubric[] = [
  fintechAuditTrailRubric,
  fintechIdempotencyRubric,
  fintechDecimalPrecisionRubric,
  healthcarePhiRedactionRubric,
  healthcareMinimumNecessaryRubric,
  legalCitationAccuracyRubric,
  legalPrivilegePreservationRubric,
  mlResearchReproducibilityRubric,
  mlResearchDatasetProvenanceRubric,
  devopsRollbackStrategyRubric,
  devopsObservabilityRubric,
];

export class DomainRubricRegistry implements IDomainRubricRegistry {
  private readonly bySlug: ReadonlyMap<string, readonly DomainRubric[]>;
  private readonly all: readonly DomainRubric[];

  constructor(rubrics: readonly DomainRubric[] = V1_DOMAIN_RUBRICS) {
    const seenIds = new Set<string>();
    const grouped = new Map<string, DomainRubric[]>();
    for (const r of rubrics) {
      const key = `${r.domainSlug}:${r.rubricId}`;
      if (seenIds.has(key)) {
        throw new Error(`DomainRubricRegistry: duplicate rubricId ${JSON.stringify(key)}`);
      }
      seenIds.add(key);
      const bucket = grouped.get(r.domainSlug);
      if (bucket) bucket.push(r);
      else grouped.set(r.domainSlug, [r]);
    }
    this.bySlug = grouped;
    this.all = [...rubrics];
  }

  list(): readonly DomainRubric[] {
    return this.all;
  }

  forDomain(slug: DomainSlug): readonly DomainRubric[] {
    return this.bySlug.get(slug) ?? [];
  }

  forDomainAndTaskKind(slug: DomainSlug, taskKind: string): readonly DomainRubric[] {
    return this.forDomain(slug).filter((r) => r.appliesToTaskKinds.includes(taskKind));
  }
}
