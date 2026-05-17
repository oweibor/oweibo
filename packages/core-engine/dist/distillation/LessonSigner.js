"use strict";
// DONE: Phase B.4 — HMAC-SHA256 lesson signing.
// Per-tenant secret read from Vault Transit or LESSON_SIGNING_KEY env var.
// The aggregator verifies the signature and immediately strips tenantId.
Object.defineProperty(exports, "__esModule", { value: true });
exports.signLesson = signLesson;
exports.verifyLesson = verifyLesson;
exports.getTenantSecret = getTenantSecret;
const crypto_1 = require("crypto");
/**
 * The fields that are covered by the HMAC signature.
 * tenantId is included in the signed payload so the aggregator can verify
 * which tenant submitted — it is stripped AFTER verification.
 */
function signaturePayload(lesson) {
    return JSON.stringify({
        schemaVersion: lesson.schemaVersion,
        taskId: lesson.taskId,
        tenantId: lesson.tenantId,
        role: lesson.role,
        slotId: lesson.slotId,
        channel: lesson.channel,
        outcome: lesson.outcome,
        abstractPattern: lesson.abstractPattern,
        toolSequence: lesson.toolSequence,
        errorClass: lesson.errorClass,
        confidence: lesson.confidence,
        novel: lesson.novel,
        fingerprint: lesson.fingerprint,
        generatedAt: lesson.generatedAt,
    });
}
/**
 * Sign a lesson with the tenant's secret key.
 * Returns the lesson with the `signature` field populated.
 */
function signLesson(lesson, tenantSecret) {
    const payload = signaturePayload(lesson);
    const signature = (0, crypto_1.createHmac)('sha256', tenantSecret)
        .update(payload)
        .digest('hex');
    return { ...lesson, signature };
}
/**
 * Verify a signed lesson.
 * Returns true only when the HMAC is valid.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyLesson(lesson, tenantSecret) {
    if (!lesson.signature)
        return false;
    const payload = signaturePayload(lesson);
    const expected = (0, crypto_1.createHmac)('sha256', tenantSecret)
        .update(payload)
        .digest('hex');
    try {
        return (0, crypto_1.timingSafeEqual)(Buffer.from(lesson.signature, 'hex'), Buffer.from(expected, 'hex'));
    }
    catch {
        return false;
    }
}
/**
 * Look up the per-tenant signing secret.
 * Production: read from Vault Transit at `oweibo/tenants/{tenantId}/lesson-signing-key`.
 * Dev/CI: falls back to LESSON_SIGNING_KEY env var (or a per-tenant derivation of it).
 */
async function getTenantSecret(tenantId, vaultClient) {
    if (vaultClient) {
        try {
            const result = await vaultClient.read(`oweibo/tenants/${tenantId}/lesson-signing-key`);
            return result.data.key;
        }
        catch {
            // Vault unreachable — fall through to env-var derivation.
        }
    }
    const base = process.env['LESSON_SIGNING_KEY'] ?? 'dev-lesson-key-replace-in-prod';
    // Derive per-tenant key by hashing base + tenantId (never exposes base key directly).
    return (0, crypto_1.createHmac)('sha256', base).update(tenantId).digest('hex');
}
//# sourceMappingURL=LessonSigner.js.map