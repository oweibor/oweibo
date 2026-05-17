import type { LessonV1 } from '@oweibo/core-contracts';
/**
 * Sign a lesson with the tenant's secret key.
 * Returns the lesson with the `signature` field populated.
 */
export declare function signLesson(lesson: Omit<LessonV1, 'signature'>, tenantSecret: string): LessonV1;
/**
 * Verify a signed lesson.
 * Returns true only when the HMAC is valid.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export declare function verifyLesson(lesson: LessonV1, tenantSecret: string): boolean;
/**
 * Look up the per-tenant signing secret.
 * Production: read from Vault Transit at `oweibo/tenants/{tenantId}/lesson-signing-key`.
 * Dev/CI: falls back to LESSON_SIGNING_KEY env var (or a per-tenant derivation of it).
 */
export declare function getTenantSecret(tenantId: string, vaultClient?: {
    read(path: string): Promise<{
        data: {
            key: string;
        };
    }>;
}): Promise<string>;
//# sourceMappingURL=LessonSigner.d.ts.map