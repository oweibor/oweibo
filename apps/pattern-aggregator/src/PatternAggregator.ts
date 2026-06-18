// DONE: Phase B.5 — PatternAggregator.
// Redis subscriber on platform.lesson.submitted.
// Pipeline: HMAC verify → tenant identity strip → re-DLP → confidence gate →
//           k-anonymity gate → INSERT oweibo.platform_lessons.

import type { Pool } from 'pg';
import type { LessonV1, AnonymisedLesson } from '@oweibo/core-contracts';
import { verifyLesson, getTenantSecret } from './LessonVerifier.js';
import { applyDLPFilter } from './DLPFilter.js';
import { LessonV1Schema } from './LessonValidator.js';

// K-anonymity threshold: a bucket must have ≥ K distinct tenants before
// lessons in that bucket can be read by the GEPA optimizer.
const K_ANONYMITY_THRESHOLD = 5;

// Minimum confidence for a lesson to be stored.
const MIN_CONFIDENCE = 0.30;

export interface AggregatorDeps {
  readonly pool:       Pool;
  readonly getSecret:  (tenantId: string) => Promise<string>;
  readonly increment?: (counter: string, labels?: Record<string, string>) => void;
}

/**
 * Process one raw Redis message from platform.lesson.submitted.
 * All failures are caught — the subscriber must never crash.
 */
export async function processLessonMessage(
  raw:  string,
  deps: AggregatorDeps,
): Promise<void> {
  let lesson: LessonV1;
  try {
    lesson = JSON.parse(raw) as LessonV1;
  } catch {
    deps.increment?.('aggregator_parse_error_total');
    return;
  }

  // ── Schema validation ────────────────────────────────────────────────────
  const validated = LessonV1Schema.safeParse(lesson);
  if (!validated.success) {
    deps.increment?.('aggregator_schema_error_total');
    return;
  }

  // ── HMAC signature verification ──────────────────────────────────────────
  const tenantSecret = await deps.getSecret(lesson.tenantId).catch(() => null);
  if (!tenantSecret || !verifyLesson(lesson, tenantSecret)) {
    deps.increment?.('aggregator_hmac_reject_total');
    return;
  }

  // ── Confidence gate ──────────────────────────────────────────────────────
  if (lesson.confidence < MIN_CONFIDENCE) {
    deps.increment?.('aggregator_confidence_drop_total');
    return;
  }

  // ── Re-DLP on stored pattern ─────────────────────────────────────────────
  const dlp = applyDLPFilter(lesson.abstractPattern);
  if (!dlp.pass) {
    deps.increment?.('aggregator_dlp_reject_total', { rejections: dlp.rejections.join(',') });
    return;
  }

  // ── Strip tenant identity — aggregator never stores tenantId ────────────
  const anonymised: AnonymisedLesson = {
    schemaVersion:       lesson.schemaVersion,
    role:                lesson.role,
    slotId:              lesson.slotId,
    channel:             lesson.channel,
    outcome:             lesson.outcome,
    abstractPattern:     lesson.abstractPattern,
    toolSequence:        lesson.toolSequence,
    errorClass:          lesson.errorClass,
    subgoalCount:        lesson.subgoalCount,
    dependencyEdgeCount: lesson.dependencyEdgeCount,
    estimatedComplexity: lesson.estimatedComplexity,
    confidence:          lesson.confidence,
    novel:               lesson.novel,
    fingerprint:         lesson.fingerprint,
    generatedAt:         lesson.generatedAt,
  };

  // ── Bucket key — deterministic content hash of role+slotId+errorClass ────
  const bucketKey = `${lesson.role}:${lesson.slotId}:${lesson.errorClass ?? 'none'}`;

  // ── T.8: capture source tenant's home_region BEFORE stripping identity.
  // The region is a coarse geographic bucket shared by many tenants — it is
  // not a tenant identifier and is safe to persist alongside the anonymised
  // lesson. If lookup fails (tenant deleted, DB hiccup), fall back to NULL
  // (region-neutral) so the lesson is still stored but reaches all consumers.
  let homeRegion: string | null = null;
  try {
    const r = await deps.pool.query<{ home_region: string }>(
      `SELECT home_region FROM oweibo.tenants WHERE id = $1`,
      [lesson.tenantId],
    );
    homeRegion = r.rows[0]?.home_region ?? null;
  } catch {
    homeRegion = null;
  }

  // ── INSERT oweibo.platform_lessons ───────────────────────────────────────
  // ON CONFLICT DO NOTHING — fingerprint is the dedup key.
  try {
    await deps.pool.query(
      `INSERT INTO oweibo.platform_lessons
         (fingerprint, bucket_key, schema_version, role, slot_id, channel,
          outcome, abstract_pattern, tool_sequence, error_class,
          subgoal_count, dependency_edge_count, estimated_complexity,
          confidence, generated_at, home_region)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (fingerprint) DO NOTHING`,
      [
        anonymised.fingerprint,
        bucketKey,
        anonymised.schemaVersion,
        anonymised.role,
        anonymised.slotId,
        anonymised.channel,
        anonymised.outcome,
        anonymised.abstractPattern,
        JSON.stringify(anonymised.toolSequence ?? []),
        anonymised.errorClass ?? null,
        anonymised.subgoalCount ?? null,
        anonymised.dependencyEdgeCount ?? null,
        anonymised.estimatedComplexity ?? null,
        anonymised.confidence,
        anonymised.generatedAt,
        homeRegion,
      ],
    );
    deps.increment?.('aggregator_lesson_stored_total', { role: lesson.role });
  } catch (err) {
    deps.increment?.('aggregator_db_error_total');
    console.error('[PatternAggregator] DB insert failed:', err);
  }
}

/**
 * Check whether a bucket has met k-anonymity threshold.
 * Used by the GEPA optimizer before reading lessons from a bucket.
 */
export async function isBucketReleasable(
  bucketKey: string,
  pool:       Pool,
): Promise<boolean> {
  const result = await pool.query<{ tenant_count: string }>(
    `SELECT tenant_count FROM oweibo.releasable_buckets WHERE bucket_key = $1`,
    [bucketKey],
  );
  const count = parseInt(result.rows[0]?.tenant_count ?? '0', 10);
  return count >= K_ANONYMITY_THRESHOLD;
}
