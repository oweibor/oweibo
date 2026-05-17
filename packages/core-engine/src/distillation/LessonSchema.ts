// DONE: Phase B.1 — Zod runtime schema for LessonV1.
// TypeScript interface lives in @oweibo/core-contracts/lesson.ts (zero-dep).
// This module holds the runtime validator used by the distillation worker
// and aggregator for schema-version routing.

import { z } from 'zod';
import type { LessonV1, CanonicalRole } from '@oweibo/core-contracts';
import { CANONICAL_ROLES } from '@oweibo/core-contracts';

export const LessonV1Schema = z.object({
  schemaVersion:        z.literal('1'),
  taskId:               z.string().uuid(),
  tenantId:             z.string().uuid(),
  role:                 z.enum([...CANONICAL_ROLES] as [CanonicalRole, ...CanonicalRole[]]),
  slotId:               z.string().min(1).max(100),
  channel:              z.string().min(1).max(100),
  outcome:              z.enum(['success', 'failure', 'recovery']),
  abstractPattern:      z.string().min(10).max(2_000),
  toolSequence:         z.array(z.string().max(100)).max(50).optional(),
  errorClass:           z.string().max(100).optional(),
  subgoalCount:         z.number().int().nonnegative().optional(),
  dependencyEdgeCount:  z.number().int().nonnegative().optional(),
  estimatedComplexity:  z.number().nonnegative().optional(),
  confidence:           z.number().min(0).max(1),
  novel:                z.boolean(),
  fingerprint:          z.string().length(64),   // SHA256 hex
  generatedAt:          z.string().datetime(),
  signature:            z.string().optional(),
}) satisfies z.ZodType<LessonV1>;

export type ValidatedLessonV1 = z.infer<typeof LessonV1Schema>;

/** Parse with detailed error messages. Returns Ok/Err discriminated union. */
export function parseLesson(raw: unknown):
  | { ok: true; lesson: ValidatedLessonV1 }
  | { ok: false; errors: string } {
  const result = LessonV1Schema.safeParse(raw);
  if (result.success) return { ok: true, lesson: result.data };
  return { ok: false, errors: result.error.message };
}
