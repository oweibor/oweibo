// Re-exports from core-engine — isolated copy to keep app self-contained.
import { createHmac, timingSafeEqual } from 'crypto';
import type { LessonV1 } from '@oweibo/core-contracts';

function signaturePayload(lesson: Omit<LessonV1, 'signature'>): string {
  return JSON.stringify({
    schemaVersion:   lesson.schemaVersion,
    taskId:          lesson.taskId,
    tenantId:        lesson.tenantId,
    role:            lesson.role,
    slotId:          lesson.slotId,
    channel:         lesson.channel,
    outcome:         lesson.outcome,
    abstractPattern: lesson.abstractPattern,
    toolSequence:    lesson.toolSequence,
    errorClass:      lesson.errorClass,
    confidence:      lesson.confidence,
    novel:           lesson.novel,
    fingerprint:     lesson.fingerprint,
    generatedAt:     lesson.generatedAt,
  });
}

export function verifyLesson(lesson: LessonV1, tenantSecret: string): boolean {
  if (!lesson.signature) return false;
  const expected = createHmac('sha256', tenantSecret)
    .update(signaturePayload(lesson))
    .digest('hex');
  try {
    return timingSafeEqual(
      Buffer.from(lesson.signature, 'hex'),
      Buffer.from(expected,         'hex'),
    );
  } catch { return false; }
}

export async function getTenantSecret(tenantId: string): Promise<string> {
  const base = process.env['LESSON_SIGNING_KEY'] ?? 'dev-lesson-key-replace-in-prod';
  return createHmac('sha256', base).update(tenantId).digest('hex');
}
