// B.7 — PrivacyAuditService: read-only data for the admin-web /(platform)/privacy/audit page.
//
// Three surfaces (§5 + §5.5 + §10.4):
//   - DLP rejects timeline:    counts per day per stage from oweibo.dlp_rejects
//   - k-anonymity blocks:      buckets present in oweibo.platform_lessons but NOT
//                              in oweibo.releasable_buckets (i.e. tenant_count < 5)
//   - Lessons-per-tenant equity: per-bucket, the maximum % of lessons contributed
//                              by any single tenant (flag if > 10%, per the
//                              "no single batch > 10% of bucket" invariant).
//
// Plus an `overview()` of platform-wide totals shown at the top of the page.

import type { Pool } from 'pg';

export interface DlpRejectsTimelinePoint {
  day:   string;
  stage: string;
  count: number;
}

export interface DlpRejectsByStage {
  stage: string;
  count: number;
}

export interface BlockedBucket {
  bucketKey:    string;
  role:         string;
  slotId:       string;
  lessonCount:  number;
  tenantCount:  number;       // < 5 (the k-anonymity threshold)
  oldestLessonAt: string;
  latestLessonAt: string;
}

export interface EquityViolation {
  bucketKey:        string;
  role:             string;
  slotId:           string;
  totalLessons:     number;
  totalTenants:     number;
  dominantTenantPct: number;  // max contribution % from any single tenant
}

export interface PrivacyOverview {
  totalLessons:       number;
  totalBuckets:       number;
  releasableBuckets:  number;
  blockedBuckets:     number;
  totalRejectsLast7d: number;
  participatingTenants: number;
}

export class PrivacyAuditService {
  constructor(private readonly pool: Pool) {}

  async overview(): Promise<PrivacyOverview> {
    const [lessons, buckets, releasable, rejects7d, tenants] = await Promise.all([
      this.pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM oweibo.platform_lessons`),
      this.pool.query<{ cnt: string }>(
        `SELECT COUNT(DISTINCT bucket_key) AS cnt FROM oweibo.platform_lessons`,
      ),
      this.pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM oweibo.releasable_buckets`),
      this.pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM oweibo.dlp_rejects WHERE rejected_at > NOW() - INTERVAL '7 days'`,
      ).catch(() => ({ rows: [{ cnt: '0' }] })),
      this.pool.query<{ cnt: string }>(
        `SELECT COUNT(DISTINCT tenant_hash) AS cnt FROM oweibo.platform_lesson_tenants`,
      ),
    ]);

    const totalBuckets      = parseInt(buckets.rows[0]?.cnt ?? '0', 10);
    const releasableBuckets = parseInt(releasable.rows[0]?.cnt ?? '0', 10);

    return {
      totalLessons:         parseInt(lessons.rows[0]?.cnt    ?? '0', 10),
      totalBuckets:         totalBuckets,
      releasableBuckets:    releasableBuckets,
      blockedBuckets:       Math.max(0, totalBuckets - releasableBuckets),
      totalRejectsLast7d:   parseInt(rejects7d.rows[0]?.cnt  ?? '0', 10),
      participatingTenants: parseInt(tenants.rows[0]?.cnt    ?? '0', 10),
    };
  }

  /** Daily DLP reject counts per stage, oldest first (good for chart x-axis). */
  async dlpRejectsTimeline(days = 14): Promise<DlpRejectsTimelinePoint[]> {
    const res = await this.pool.query<{ day: string; stage: string; cnt: string }>(
      `SELECT
         date_trunc('day', rejected_at)::date::text AS day,
         reject_stage                               AS stage,
         COUNT(*)::text                             AS cnt
       FROM oweibo.dlp_rejects
       WHERE rejected_at > NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY date_trunc('day', rejected_at), reject_stage
       ORDER BY day, stage`,
      [days],
    ).catch(() => ({ rows: [] as Array<{ day: string; stage: string; cnt: string }> }));
    return res.rows.map(r => ({
      day:   r.day,
      stage: r.stage,
      count: parseInt(r.cnt, 10),
    }));
  }

  /** Reject totals grouped by stage over the window. */
  async dlpRejectsByStage(days = 14): Promise<DlpRejectsByStage[]> {
    const res = await this.pool.query<{ stage: string; cnt: string }>(
      `SELECT reject_stage AS stage, COUNT(*)::text AS cnt
       FROM oweibo.dlp_rejects
       WHERE rejected_at > NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY reject_stage
       ORDER BY COUNT(*) DESC`,
      [days],
    ).catch(() => ({ rows: [] as Array<{ stage: string; cnt: string }> }));
    return res.rows.map(r => ({
      stage: r.stage,
      count: parseInt(r.cnt, 10),
    }));
  }

  /**
   * Buckets that have lessons but haven't crossed the k=5 tenants threshold.
   * These are blocked from `releasable_buckets` and invisible to GEPA.
   */
  async blockedBuckets(limit = 50): Promise<BlockedBucket[]> {
    const res = await this.pool.query<{
      bucket_key: string; role: string; slot_id: string;
      lesson_count: string; tenant_count: string;
      oldest_lesson_at: string; latest_lesson_at: string;
    }>(
      `SELECT pl.bucket_key,
              pl.role,
              pl.slot_id,
              COUNT(pl.fingerprint)::text          AS lesson_count,
              COUNT(DISTINCT plt.tenant_hash)::text AS tenant_count,
              MIN(pl.aggregated_at)                AS oldest_lesson_at,
              MAX(pl.aggregated_at)                AS latest_lesson_at
       FROM oweibo.platform_lessons pl
       JOIN oweibo.platform_lesson_tenants plt USING (bucket_key)
       GROUP BY pl.bucket_key, pl.role, pl.slot_id
       HAVING COUNT(DISTINCT plt.tenant_hash) < 5
       ORDER BY MAX(pl.aggregated_at) DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map(r => ({
      bucketKey:      r.bucket_key,
      role:           r.role,
      slotId:         r.slot_id,
      lessonCount:    parseInt(r.lesson_count, 10),
      tenantCount:    parseInt(r.tenant_count, 10),
      oldestLessonAt: r.oldest_lesson_at,
      latestLessonAt: r.latest_lesson_at,
    }));
  }

  /**
   * Per-bucket, the max % of lessons contributed by any single tenant.
   * Returns only buckets that violate the 10% invariant — i.e. one tenant
   * dominates > 10% of the bucket — so the page can show the offenders.
   *
   * Note: platform_lessons has no tenant_hash column (intentional — only
   * fingerprint of the lesson, not the tenant). platform_lesson_tenants
   * records which tenants contributed to each bucket but not how many
   * each contributed. Without per-(tenant, bucket) lesson counts, this
   * method approximates "dominance" as: if a bucket has lessonCount
   * lessons but only N distinct tenants, the average per-tenant share is
   * lessonCount / N. We compare that average to 10% as a *minimum
   * dominance* — actual dominance can only be higher. A future enhancement
   * would add per-(tenant,bucket) lesson counts to platform_lesson_tenants.
   */
  async equityViolations(): Promise<EquityViolation[]> {
    const res = await this.pool.query<{
      bucket_key: string; role: string; slot_id: string;
      total_lessons: string; total_tenants: string;
    }>(
      `SELECT pl.bucket_key,
              pl.role,
              pl.slot_id,
              COUNT(pl.fingerprint)::text          AS total_lessons,
              COUNT(DISTINCT plt.tenant_hash)::text AS total_tenants
       FROM oweibo.platform_lessons pl
       JOIN oweibo.platform_lesson_tenants plt USING (bucket_key)
       GROUP BY pl.bucket_key, pl.role, pl.slot_id`,
    );
    return res.rows
      .map(r => {
        const total   = parseInt(r.total_lessons, 10);
        const tenants = Math.max(1, parseInt(r.total_tenants, 10));
        // Average per-tenant share — a lower bound on dominance.
        const dominantPct = (total / tenants) / total * 100;  // == (1 / tenants) * 100
        return {
          bucketKey:        r.bucket_key,
          role:             r.role,
          slotId:           r.slot_id,
          totalLessons:     total,
          totalTenants:     tenants,
          dominantTenantPct: dominantPct,
        };
      })
      .filter(b => b.dominantTenantPct > 10)
      .sort((a, b) => b.dominantTenantPct - a.dominantTenantPct);
  }
}
