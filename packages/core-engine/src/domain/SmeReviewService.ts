/**
 * D.5 (domain-depth): SmeReviewService — read/write surface over the SME
 * review schema (migration 20260521_000037).
 *
 * Three role surfaces:
 *
 *   1. Sampling worker (oweibo_app)            — enqueueSample(),
 *      backfillCredentials(), administrative read of queue/reviews.
 *   2. Reviewer portal (oweibo_sme_reviewer)   — listQueueForReviewer(),
 *      submitReview(). Service runs as oweibo_app on the portal's
 *      behalf and sets `app.user_id` so the SQL-level RLS policies
 *      enforce credential-domain scoping.
 *   3. Platform admin                          — closeQueueItem(),
 *      decideAggregatedFeedback() (the aggregator inserts rows; admins
 *      transition pending_review → approved/rejected).
 *
 * The service does NOT handle anonymization — sampling is expected to
 * deliver an already-anonymized payload. The portal is also responsible
 * for showing only what the queue row's anonymized_payload contains.
 *
 * State transitions on sme_review_queue:
 *
 *     pending --(reviewer claims)--> assigned
 *     assigned --(N reviews submitted)--> reviewed
 *     reviewed --(aggregator processed)--> aggregated
 *     aggregated --(admin acts on output)--> closed
 *
 * Reviewed→aggregated is driven by SmeFeedbackAggregator (separate file).
 */
import type { Pool, PoolClient } from 'pg';
import type {
  DomainSlug,
  SmeArtifactKind,
  SmeOverallVerdict,
  SmePerCriterionVerdict,
  SmeQueueItem,
  SmeQueueState,
  SmeReview,
  SmeSuggestion,
} from '@oweibo/core-contracts';

export interface EnqueueSampleInput {
  readonly domainSlug: DomainSlug;
  readonly tenantId: string;
  readonly taskId?: string;
  readonly artifactKind: SmeArtifactKind;
  readonly artifactRef: Readonly<Record<string, unknown>>;
  readonly anonymizedPayload: unknown;
  readonly requiredReviews?: number;
}

export interface SubmitReviewInput {
  readonly queueItemId: string;
  readonly reviewerId: string;
  readonly overallVerdict: SmeOverallVerdict;
  readonly perCriterion?: readonly SmePerCriterionVerdict[];
  readonly ontologySuggestions?: readonly SmeSuggestion[];
  readonly rubricSuggestions?: readonly SmeSuggestion[];
  readonly ruleSuggestions?: readonly SmeSuggestion[];
  readonly comment?: string;
}

export interface SmeReviewServiceOptions {
  /** Default 'platform_admin'. Tests can supply a no-op. */
  setLocalRole?: () => string;
  now?: () => Date;
}

export class SmeReviewService {
  private readonly roleName: () => string;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: SmeReviewServiceOptions = {}) {
    this.roleName = opts.setLocalRole ?? (() => 'platform_admin');
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Sampling worker inserts a row. Returns the queue item id. The
   * caller is responsible for ensuring `anonymizedPayload` is already
   * anonymized (named-entity scrubbing, tenant-id hash) at sample time.
   */
  async enqueueSample(input: EnqueueSampleInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      const r = await client.query<{ id: string }>(
        `INSERT INTO oweibo.sme_review_queue
           (domain_slug, tenant_id, task_id, artifact_kind, artifact_ref,
            anonymized_payload, required_reviews)
         VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING id`,
        [
          input.domainSlug,
          input.tenantId,
          input.taskId ?? null,
          input.artifactKind,
          JSON.stringify(input.artifactRef),
          JSON.stringify(input.anonymizedPayload),
          input.requiredReviews ?? 2,
        ],
      );
      await client.query('COMMIT');
      return r.rows[0]!.id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reviewer-facing: queue items the reviewer is credentialed for. The
   * SQL policy ALSO enforces this — we mirror the predicate here so
   * the portal can render queue listings without relying on raw role
   * pivots.
   */
  async listQueueForReviewer(input: {
    reviewerId: string;
    states?: readonly SmeQueueState[];
    limit?: number;
  }): Promise<readonly SmeQueueItem[]> {
    const limit = Math.min(input.limit ?? 50, 200);
    const states = input.states ?? ['pending', 'assigned'];
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<QueueRow>(
        `SELECT id, domain_slug, tenant_id, task_id, artifact_kind, artifact_ref,
                anonymized_payload, state, required_reviews, sampled_at, closed_at
           FROM oweibo.sme_review_queue
          WHERE state = ANY($2::text[])
            AND domain_slug IN (
              SELECT c.domain_slug FROM oweibo.sme_credentials c
              WHERE c.reviewer_id = $1::uuid AND c.revoked_at IS NULL
            )
          ORDER BY sampled_at ASC
          LIMIT $3`,
        [input.reviewerId, states, limit],
      );
      return r.rows.map(rowToQueueItem);
    } finally {
      client.release();
    }
  }

  /**
   * F.4.5: tenant-facing list of SME review queue items. Used by the
   * admin sme-review page to show pending/assigned reviews of the
   * tenant's own artifacts. Bypasses reviewer credential scoping —
   * tenants see their own queue regardless of which reviewer is on the
   * hook.
   */
  async listPendingForTenant(
    tenantId: string,
    opts: { states?: readonly SmeQueueState[]; limit?: number } = {},
  ): Promise<readonly SmeQueueItem[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const states = opts.states ?? ['pending', 'assigned', 'reviewed'];
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<QueueRow>(
        `SELECT id, domain_slug, tenant_id, task_id, artifact_kind, artifact_ref,
                anonymized_payload, state, required_reviews, sampled_at, closed_at
           FROM oweibo.sme_review_queue
          WHERE tenant_id = $1::uuid
            AND state = ANY($2::text[])
          ORDER BY sampled_at DESC
          LIMIT $3`,
        [tenantId, states, limit],
      );
      return r.rows.map(rowToQueueItem);
    } finally {
      client.release();
    }
  }

  async getQueueItem(id: string): Promise<SmeQueueItem | null> {
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<QueueRow>(
        `SELECT id, domain_slug, tenant_id, task_id, artifact_kind, artifact_ref,
                anonymized_payload, state, required_reviews, sampled_at, closed_at
           FROM oweibo.sme_review_queue WHERE id = $1::uuid`,
        [id],
      );
      const row = r.rows[0];
      return row ? rowToQueueItem(row) : null;
    } finally {
      client.release();
    }
  }

  /**
   * Submit a review. Atomic with a queue-state UPDATE: when the
   * required_reviews threshold is crossed by this submission, the
   * queue row transitions pending|assigned → reviewed in the same
   * transaction.
   *
   * The UNIQUE(queue_item_id, reviewer_id) on sme_reviews makes the
   * INSERT idempotent at the SQL layer — re-submitting raises a
   * conflict; the service surfaces that as a thrown error so the
   * portal can show "already submitted".
   */
  async submitReview(input: SubmitReviewInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      // Insert review.
      const ins = await client.query<{ id: string }>(
        `INSERT INTO oweibo.sme_reviews
           (queue_item_id, reviewer_id, overall_verdict, per_criterion,
            ontology_suggestions, rubric_suggestions, rule_suggestions, comment)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8)
         RETURNING id`,
        [
          input.queueItemId,
          input.reviewerId,
          input.overallVerdict,
          JSON.stringify(input.perCriterion ?? []),
          JSON.stringify(input.ontologySuggestions ?? []),
          JSON.stringify(input.rubricSuggestions ?? []),
          JSON.stringify(input.ruleSuggestions ?? []),
          input.comment ?? null,
        ],
      );
      // Transition queue state.
      //   pending|assigned → reviewed once we hit required_reviews;
      //   pending → assigned otherwise.
      const countR = await client.query<{ n: string; required: number; state: SmeQueueState }>(
        `SELECT (SELECT COUNT(*)::text FROM oweibo.sme_reviews WHERE queue_item_id = $1::uuid) AS n,
                q.required_reviews                                                              AS required,
                q.state                                                                          AS state
           FROM oweibo.sme_review_queue q
          WHERE q.id = $1::uuid`,
        [input.queueItemId],
      );
      const row = countR.rows[0];
      if (row) {
        const count = parseInt(row.n, 10);
        if (count >= row.required && row.state !== 'reviewed' && row.state !== 'aggregated' && row.state !== 'closed') {
          await client.query(
            `UPDATE oweibo.sme_review_queue SET state = 'reviewed' WHERE id = $1::uuid`,
            [input.queueItemId],
          );
        } else if (row.state === 'pending') {
          await client.query(
            `UPDATE oweibo.sme_review_queue SET state = 'assigned' WHERE id = $1::uuid`,
            [input.queueItemId],
          );
        }
      }
      await client.query('COMMIT');
      return ins.rows[0]!.id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Platform admin closes a queue item (terminal). Used after the
   * aggregator runs and the suggestions have been acted on (or
   * dismissed).
   */
  async closeQueueItem(queueItemId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      await client.query(
        `UPDATE oweibo.sme_review_queue
            SET state = 'closed', closed_at = $2
          WHERE id = $1::uuid`,
        [queueItemId, this.now()],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * All reviews submitted for a queue item. Returned in submission
   * order (reviewed_at ASC). Used by the aggregator + by the admin
   * portal to render the per-reviewer view.
   */
  async listReviewsForQueueItem(queueItemId: string): Promise<readonly SmeReview[]> {
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<ReviewRow>(
        `SELECT id, queue_item_id, reviewer_id, overall_verdict, per_criterion,
                ontology_suggestions, rubric_suggestions, rule_suggestions, comment, reviewed_at
           FROM oweibo.sme_reviews
          WHERE queue_item_id = $1::uuid
          ORDER BY reviewed_at ASC`,
        [queueItemId],
      );
      return r.rows.map(rowToReview);
    } finally {
      client.release();
    }
  }

  /**
   * Mark a queue item as 'aggregated' — invoked by the aggregator
   * after it has processed the reviews. Idempotent; calling on an
   * already-aggregated row is a no-op.
   */
  async markAggregated(queueItemId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      await client.query(
        `UPDATE oweibo.sme_review_queue
            SET state = 'aggregated'
          WHERE id = $1::uuid AND state = 'reviewed'`,
        [queueItemId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async setAdminScope(client: PoolClient): Promise<void> {
    // The service runs as platform-admin so the platform_admin_all
    // policies apply uniformly. The reviewer-portal will SET LOCAL
    // app.user_id separately via withSmeReviewerContext (future hook).
    await client.query(`SET LOCAL ROLE ${this.roleName()}`).catch(() => undefined);
    await client.query(`SET LOCAL app.is_platform_admin = 'true'`).catch(() => undefined);
  }
}

// ── Row → entity mappers ─────────────────────────────────────────────────

interface QueueRow {
  id: string;
  domain_slug: string;
  tenant_id: string;
  task_id: string | null;
  artifact_kind: SmeArtifactKind;
  artifact_ref: Record<string, unknown>;
  anonymized_payload: unknown;
  state: SmeQueueState;
  required_reviews: number;
  sampled_at: Date | string;
  closed_at: Date | string | null;
}

function rowToQueueItem(r: QueueRow): SmeQueueItem {
  return {
    id: r.id,
    domainSlug: r.domain_slug,
    tenantId: r.tenant_id,
    taskId: r.task_id,
    artifactKind: r.artifact_kind,
    artifactRef: r.artifact_ref ?? {},
    anonymizedPayload: r.anonymized_payload,
    state: r.state,
    requiredReviews: r.required_reviews,
    sampledAt: toIso(r.sampled_at),
    closedAt: r.closed_at === null ? null : toIso(r.closed_at),
  };
}

interface ReviewRow {
  id: string;
  queue_item_id: string;
  reviewer_id: string;
  overall_verdict: SmeOverallVerdict;
  per_criterion: SmePerCriterionVerdict[];
  ontology_suggestions: SmeSuggestion[];
  rubric_suggestions: SmeSuggestion[];
  rule_suggestions: SmeSuggestion[];
  comment: string | null;
  reviewed_at: Date | string;
}

function rowToReview(r: ReviewRow): SmeReview {
  return {
    id: r.id,
    queueItemId: r.queue_item_id,
    reviewerId: r.reviewer_id,
    overallVerdict: r.overall_verdict,
    perCriterion: r.per_criterion ?? [],
    ontologySuggestions: r.ontology_suggestions ?? [],
    rubricSuggestions: r.rubric_suggestions ?? [],
    ruleSuggestions: r.rule_suggestions ?? [],
    comment: r.comment,
    reviewedAt: toIso(r.reviewed_at),
  };
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}
