// DONE: Phase B.1 — LessonV1 contract type.
// Zod schema lives in core-engine/src/distillation/LessonSchema.ts to keep this
// package zero-dependency. All fields that identify a tenant are stripped by the
// aggregator before writing to platform_lessons.

import type { CanonicalRole } from './roles.js';

/** Task outcome categories that drive lesson generation. */
export type LessonOutcome = 'success' | 'failure' | 'recovery';

/**
 * LessonV1 — the cross-tenant privacy-safe lesson object.
 *
 * Lifecycle:
 *   1. TenantDistillationWorker generates this from a completed task.
 *   2. LessonDLPFilter validates that no raw identifiers are present.
 *   3. LessonSigner appends an HMAC-SHA256 signature (per-tenant secret).
 *   4. Published to Redis channel `platform.lesson.submitted`.
 *   5. PatternAggregator validates signature → strips tenantId → re-DLP →
 *      k-anonymity gate → INSERT oweibo.platform_lessons.
 *
 * §5 privacy contract: tenantId MUST be stripped before aggregator writes.
 * abstractPattern MUST pass LessonDLPFilter before being signed.
 */
export interface LessonV1 {
  /** Schema version — aggregator routes by this field. Always '1' for this type. */
  readonly schemaVersion: '1';

  /** Task identifier — stripped by aggregator after HMAC validation. */
  readonly taskId: string;

  /** Tenant identifier — stripped by aggregator after HMAC validation. */
  readonly tenantId: string;

  /** Agent role that produced the lesson signal. */
  readonly role: CanonicalRole;

  /** Prompt slot this lesson applies to (e.g. 'decomposition_rules'). */
  readonly slotId: string;

  /** Cohort channel the task ran on (e.g. 'stable-v0'). */
  readonly channel: string;

  /** Task outcome category. */
  readonly outcome: LessonOutcome;

  /**
   * Distilled procedural insight — DLP-filtered, no raw identifiers.
   * Abstract and general: describes a class of problem/solution, not a specific one.
   */
  readonly abstractPattern: string;

  /** Ordered tool names used during the task (no arguments — identifiers stripped). */
  readonly toolSequence?: readonly string[];

  /**
   * Categorised error class for failure/recovery outcomes.
   * Must be a generic category (e.g. 'SANDBOX_TIMEOUT'), not a specific message.
   */
  readonly errorClass?: string;

  /** Subgoal count from GoalDecomposer span. */
  readonly subgoalCount?: number;

  /** Dependency edge count from GoalDecomposer span. */
  readonly dependencyEdgeCount?: number;

  /** Estimated complexity from GoalDecomposer span. */
  readonly estimatedComplexity?: number;

  /**
   * Confidence score (0–1) that this lesson is genuine and generalisable.
   * Below 0.3 → dropped by aggregator (closes audit gap B-07).
   */
  readonly confidence: number;

  /** True if this task was classified as novel by the NoveltyClassifier. */
  readonly novel: boolean;

  /**
   * Fingerprint = SHA256(taskId + role + slotId + (errorClass ?? '')).
   * Used for deduplication in oweibo.platform_lessons.
   */
  readonly fingerprint: string;

  /** ISO-8601 timestamp of lesson generation. */
  readonly generatedAt: string;

  /** HMAC-SHA256 hex signature appended by LessonSigner (absent before signing). */
  readonly signature?: string;
}

/** LessonV1 with tenantId and taskId stripped (post-aggregation form). */
export type AnonymisedLesson = Omit<LessonV1, 'tenantId' | 'taskId' | 'signature'>;
