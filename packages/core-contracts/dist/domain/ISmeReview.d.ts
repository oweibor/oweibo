/**
 * D.5 (domain-depth): SME review loop contracts.
 *
 * The SME review portal samples tenant outputs, routes them to
 * domain-credentialed reviewers, and aggregates structured suggestions
 * into platform-team-actionable rows. This file defines the data
 * shapes; runtime services live in core-engine.
 *
 * Privacy: queue items carry an `anonymizedPayload`. Enterprise-tier
 * tenants may opt in to *attributed* review (the original tenant id
 * surfaces to NDA-signed SMEs) — that switch is at sample time, not
 * here.
 */
import type { DomainSlug } from './DomainSlug.js';
export type SmeReviewerKind = 'platform_employee' | 'contracted_sme' | 'partner_org_sme';
export type SmeCredentialKind = 'platform_employee' | 'contracted_sme' | 'tenant_attested';
export interface SmeReviewer {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
    readonly authSubject: string;
    readonly kind: SmeReviewerKind;
    readonly createdAt: string;
    readonly disabledAt: string | null;
}
export interface SmeCredential {
    readonly reviewerId: string;
    readonly domainSlug: DomainSlug;
    readonly credentialsKind: SmeCredentialKind;
    readonly validatedBy: string | null;
    readonly validatedAt: string;
    readonly revokedAt: string | null;
}
/** What kind of artifact is being reviewed. */
export type SmeArtifactKind = 'task_output' | 'rubric_evaluation' | 'compliance_decision' | 'regulatory_feed_item';
export type SmeQueueState = 'pending' | 'assigned' | 'reviewed' | 'aggregated' | 'closed';
export interface SmeQueueItem {
    readonly id: string;
    readonly domainSlug: DomainSlug;
    readonly tenantId: string;
    readonly taskId: string | null;
    readonly artifactKind: SmeArtifactKind;
    readonly artifactRef: Readonly<Record<string, unknown>>;
    readonly anonymizedPayload: unknown;
    readonly state: SmeQueueState;
    readonly requiredReviews: number;
    readonly sampledAt: string;
    readonly closedAt: string | null;
}
export type SmeOverallVerdict = 'correct' | 'partially_correct' | 'incorrect' | 'out_of_scope';
/**
 * Per-criterion result from an SME reviewer. Mirrors the rubric criterion
 * shape (D.2) so a reviewer can offer fine-grained signal when reviewing
 * a `rubric_evaluation` queue item.
 */
export interface SmePerCriterionVerdict {
    readonly criterionId: string;
    readonly verdict: 'pass' | 'fail' | 'borderline';
    readonly comment?: string;
}
/**
 * Target kinds an SME suggestion can address. Used to bucket
 * suggestions for the aggregator: only suggestions with matching
 * `targetKind` + `targetId` count toward agreement.
 */
export type SmeSuggestionTargetKind = 'ontology_glossary' | 'ontology_entity' | 'rubric_criterion' | 'compliance_rule' | 'classifier_weight';
export interface SmeSuggestion {
    readonly targetKind: SmeSuggestionTargetKind;
    readonly targetId: string;
    /** Free-form proposed change (JSON-serialisable). */
    readonly suggestedChange: unknown;
}
export interface SmeReview {
    readonly id: string;
    readonly queueItemId: string;
    readonly reviewerId: string;
    readonly overallVerdict: SmeOverallVerdict;
    readonly perCriterion: readonly SmePerCriterionVerdict[];
    readonly ontologySuggestions: readonly SmeSuggestion[];
    readonly rubricSuggestions: readonly SmeSuggestion[];
    readonly ruleSuggestions: readonly SmeSuggestion[];
    readonly comment: string | null;
    readonly reviewedAt: string;
}
export type SmeAggregatedFeedbackState = 'pending_review' | 'approved' | 'rejected' | 'superseded';
export interface SmeAggregatedFeedback {
    readonly id: string;
    readonly domainSlug: DomainSlug;
    readonly targetKind: SmeSuggestionTargetKind;
    readonly targetId: string;
    readonly suggestedChange: unknown;
    readonly reviewerCount: number;
    /** Fraction of reviewers offering this exact suggestion; in [0, 1]. */
    readonly agreementRatio: number;
    readonly state: SmeAggregatedFeedbackState;
    readonly reviewedBy: string | null;
    readonly reviewedAt: string | null;
    readonly decisionReason: string | null;
    readonly createdAt: string;
}
//# sourceMappingURL=ISmeReview.d.ts.map