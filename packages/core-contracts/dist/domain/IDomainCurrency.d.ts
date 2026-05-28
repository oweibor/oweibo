/**
 * D.7 (domain-depth): domain-knowledge currency contracts.
 *
 * Every domain artifact (ontology pack, eval rubric, compliance rule
 * pack, classifier) carries a validity window and a refresh policy.
 * `DomainCurrencyMonitor` runs daily, transitions states, and invokes
 * registered feed adapters to pull regulatory updates for SME review.
 *
 * Feed adapter contract is intentionally minimal — the SDK is a code
 * drop per feed (see plan §4 D.7 runbook). A blocked egress destination
 * raises a labeled error rather than silently returning empty results.
 */
import type { DomainSlug } from './DomainSlug.js';
export type DomainArtifactKind = 'ontology_pack' | 'eval_rubric' | 'compliance_rule_pack' | 'classifier';
export type DomainArtifactRefreshPolicy = 'manual' | 'annual_review' | 'feed_driven';
export type DomainArtifactState = 'current' | 'expiring_soon' | 'expired' | 'superseded';
export type RegulatoryImpactArea = 'rule_pack' | 'ontology' | 'rubric';
export type FeedItemReviewState = 'pending' | 'reviewed' | 'dismissed' | 'incorporated';
export interface DomainArtifactCurrency {
    readonly artifactKind: DomainArtifactKind;
    readonly artifactId: string;
    readonly domainSlug: DomainSlug | null;
    readonly validFrom: string;
    readonly validUntil: string;
    readonly refreshPolicy: DomainArtifactRefreshPolicy;
    /** Cadence at which feed_driven artifacts pull. Null for non-feed-driven. */
    readonly refreshIntervalSeconds: number | null;
    readonly feedRefs: readonly string[];
    readonly state: DomainArtifactState;
    readonly supersededBy: string | null;
    readonly lastStateTransition: string;
}
export interface RegulatoryUpdate {
    /** Stable per feed; UNIQUE(feed_id, update_id) prevents duplicates. */
    readonly updateId: string;
    readonly publishedAt: string;
    readonly title: string;
    readonly summary: string;
    readonly sourceUrl: string;
    readonly impactArea: RegulatoryImpactArea;
    /** Rule IDs / glossary terms the feed thinks may need an update. */
    readonly suggestedTargets: readonly string[];
}
export interface IRegulatoryFeed {
    readonly feedId: string;
    readonly domainSlug: DomainSlug;
    /**
     * Fetch updates published since the given timestamp.
     * Implementations MUST throw `DOMAIN_CURRENCY_FEED_EGRESS_BLOCKED`
     * (labeled error, see plan §4 D.7) when the egress proxy refuses
     * the destination — silent empty returns let regulatory updates
     * accumulate undetected.
     */
    fetchUpdates(since: Date): Promise<readonly RegulatoryUpdate[]>;
}
/**
 * Per-feed health row consulted by the monitor before invoking a feed.
 * If `lastSuccessfulAt` is within `refreshInterval / 4` of now, the
 * monitor SKIPS the feed for this cycle (hot-loop prevention).
 */
export interface DomainFeedHealth {
    readonly feedId: string;
    readonly lastAttemptedAt: string | null;
    readonly lastSuccessfulAt: string | null;
    readonly lastError: string | null;
    readonly consecutiveFailures: number;
}
export interface RegulatoryFeedItem {
    readonly id: string;
    readonly feedId: string;
    readonly updateId: string;
    readonly domainSlug: DomainSlug | null;
    readonly publishedAt: string;
    readonly title: string;
    readonly summary: string;
    readonly sourceUrl: string;
    readonly impactArea: RegulatoryImpactArea;
    readonly suggestedTargets: readonly string[];
    readonly reviewState: FeedItemReviewState;
    readonly ingestedAt: string;
}
/**
 * Labeled error a feed adapter MUST throw when the egress proxy denies
 * its destination. The platform alerting layer pivots on this string.
 */
export declare class DomainCurrencyFeedEgressBlocked extends Error {
    readonly feedId: string;
    readonly destination: string;
    readonly code = "DOMAIN_CURRENCY_FEED_EGRESS_BLOCKED";
    constructor(feedId: string, destination: string);
}
//# sourceMappingURL=IDomainCurrency.d.ts.map