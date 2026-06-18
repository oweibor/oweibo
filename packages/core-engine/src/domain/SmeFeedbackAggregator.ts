/**
 * D.5 (domain-depth): SmeFeedbackAggregator — folds per-reviewer
 * suggestions into platform-team-actionable rows.
 *
 * Inputs: the set of `SmeReview`s for one queue item. Each review
 * carries up to three suggestion lists (ontology / rubric / rule)
 * targeting `(targetKind, targetId)` tuples.
 *
 * Output: zero or more `sme_aggregated_feedback` rows. For each
 * (targetKind, targetId) tuple that crosses both thresholds
 * (minReviewers and minAgreement), the aggregator inserts a single
 * row with the dominant suggestedChange. Below threshold tuples are
 * stored as their own pending rows when `recordBelowThreshold = true`
 * (default false — we don't want to flood the admin queue with
 * single-reviewer suggestions).
 *
 * Agreement model:
 *   For a given (target_kind, target_id) tuple within a queue item's
 *   reviews:
 *     - `reviewerCount` = distinct reviewers offering ANY suggestion
 *       for that tuple
 *     - `dominant` = the suggestedChange JSON-canon string that the
 *       most reviewers agreed on
 *     - `agreementRatio` = dominantVotes / reviewerCount
 *
 *   Thresholds default to minReviewers=3, minAgreement=0.66 per the
 *   spec.
 *
 * State machine integration: after processing, the queue item is
 * marked `aggregated` via SmeReviewService.markAggregated().
 */
import type { Pool, PoolClient } from 'pg';
import type {
  SmeReview,
  SmeSuggestion,
  SmeSuggestionTargetKind,
} from '@oweibo/core-contracts';

export interface SmeFeedbackAggregatorOptions {
  /** Default 3 (per ttv-domain-depth.md §D.5). */
  minReviewers?: number;
  /** Default 0.66. */
  minAgreement?: number;
  /** Write a pending_review row even when thresholds not crossed (default false). */
  recordBelowThreshold?: boolean;
  /** Default 'platform_admin'. */
  setLocalRole?: () => string;
  now?: () => Date;
}

export interface AggregateForQueueItemInput {
  readonly queueItemId: string;
  readonly domainSlug: string;
  readonly reviews: readonly SmeReview[];
}

export interface AggregationResult {
  readonly inserted: number;
  readonly skipped: number;
  readonly groups: readonly AggregationGroup[];
}

export interface AggregationGroup {
  readonly targetKind: SmeSuggestionTargetKind;
  readonly targetId: string;
  readonly reviewerCount: number;
  readonly agreementRatio: number;
  readonly dominantSuggestion: unknown;
  readonly crossedThreshold: boolean;
}

interface SuggestionsByTuple {
  reviewerIds: Set<string>;
  byChange: Map<string, { reviewers: Set<string>; change: unknown }>;
}

export class SmeFeedbackAggregator {
  private readonly minReviewers: number;
  private readonly minAgreement: number;
  private readonly recordBelowThreshold: boolean;
  private readonly roleName: () => string;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: SmeFeedbackAggregatorOptions = {}) {
    this.minReviewers = opts.minReviewers ?? 3;
    this.minAgreement = opts.minAgreement ?? 0.66;
    this.recordBelowThreshold = opts.recordBelowThreshold ?? false;
    this.roleName = opts.setLocalRole ?? (() => 'platform_admin');
    this.now = opts.now ?? (() => new Date());
  }

  async aggregateForQueueItem(input: AggregateForQueueItemInput): Promise<AggregationResult> {
    const groups = groupSuggestions(input.reviews);
    const summarised: AggregationGroup[] = [];
    for (const [key, agg] of groups.entries()) {
      const reviewerCount = agg.reviewerIds.size;
      let dominantVotes = 0;
      let dominantChange: unknown = null;
      for (const entry of agg.byChange.values()) {
        if (entry.reviewers.size > dominantVotes) {
          dominantVotes = entry.reviewers.size;
          dominantChange = entry.change;
        }
      }
      const agreementRatio = reviewerCount === 0 ? 0 : dominantVotes / reviewerCount;
      const crossedThreshold =
        reviewerCount >= this.minReviewers && agreementRatio >= this.minAgreement;
      const [targetKind, targetId] = splitKey(key);
      summarised.push({
        targetKind,
        targetId,
        reviewerCount,
        agreementRatio,
        dominantSuggestion: dominantChange,
        crossedThreshold,
      });
    }

    let inserted = 0;
    let skipped = 0;
    if (summarised.length > 0) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await this.setAdminScope(client);
        for (const g of summarised) {
          if (!g.crossedThreshold && !this.recordBelowThreshold) {
            skipped++;
            continue;
          }
          await client.query(
            `INSERT INTO oweibo.sme_aggregated_feedback
               (domain_slug, target_kind, target_id, suggested_change,
                reviewer_count, agreement_ratio, state, created_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending_review', $7)`,
            [
              input.domainSlug,
              g.targetKind,
              g.targetId,
              JSON.stringify(g.dominantSuggestion),
              g.reviewerCount,
              round3(g.agreementRatio),
              this.now(),
            ],
          );
          inserted++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    return { inserted, skipped, groups: summarised };
  }

  private async setAdminScope(client: PoolClient): Promise<void> {
    await client.query(`SET LOCAL ROLE ${this.roleName()}`).catch(() => undefined);
    await client.query(`SET LOCAL app.is_platform_admin = 'true'`).catch(() => undefined);
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────

/**
 * Group every reviewer suggestion across the three lists by
 * (targetKind, targetId), tracking distinct reviewers + the
 * canonical-JSON-keyed change variants. Returns a Map keyed by
 * `${targetKind}\x00${targetId}`.
 */
export function groupSuggestions(
  reviews: readonly SmeReview[],
): Map<string, SuggestionsByTuple> {
  const groups = new Map<string, SuggestionsByTuple>();
  for (const review of reviews) {
    const all: SmeSuggestion[] = [
      ...review.ontologySuggestions,
      ...review.rubricSuggestions,
      ...review.ruleSuggestions,
    ];
    for (const s of all) {
      const key = makeKey(s.targetKind, s.targetId);
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = { reviewerIds: new Set(), byChange: new Map() };
        groups.set(key, bucket);
      }
      bucket.reviewerIds.add(review.reviewerId);
      const changeKey = canonicalJson(s.suggestedChange);
      let cv = bucket.byChange.get(changeKey);
      if (!cv) {
        cv = { reviewers: new Set(), change: s.suggestedChange };
        bucket.byChange.set(changeKey, cv);
      }
      cv.reviewers.add(review.reviewerId);
    }
  }
  return groups;
}

function makeKey(kind: SmeSuggestionTargetKind, id: string): string {
  return `${kind}\x00${id}`;
}

function splitKey(key: string): [SmeSuggestionTargetKind, string] {
  const idx = key.indexOf('\x00');
  return [key.slice(0, idx) as SmeSuggestionTargetKind, key.slice(idx + 1)];
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
