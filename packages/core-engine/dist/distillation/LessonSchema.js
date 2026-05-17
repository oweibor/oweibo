"use strict";
// DONE: Phase B.1 — Zod runtime schema for LessonV1.
// TypeScript interface lives in @oweibo/core-contracts/lesson.ts (zero-dep).
// This module holds the runtime validator used by the distillation worker
// and aggregator for schema-version routing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.LessonV1Schema = void 0;
exports.parseLesson = parseLesson;
const zod_1 = require("zod");
const core_contracts_1 = require("@oweibo/core-contracts");
exports.LessonV1Schema = zod_1.z.object({
    schemaVersion: zod_1.z.literal('1'),
    taskId: zod_1.z.string().uuid(),
    tenantId: zod_1.z.string().uuid(),
    role: zod_1.z.enum([...core_contracts_1.CANONICAL_ROLES]),
    slotId: zod_1.z.string().min(1).max(100),
    channel: zod_1.z.string().min(1).max(100),
    outcome: zod_1.z.enum(['success', 'failure', 'recovery']),
    abstractPattern: zod_1.z.string().min(10).max(2_000),
    toolSequence: zod_1.z.array(zod_1.z.string().max(100)).max(50).optional(),
    errorClass: zod_1.z.string().max(100).optional(),
    subgoalCount: zod_1.z.number().int().nonnegative().optional(),
    dependencyEdgeCount: zod_1.z.number().int().nonnegative().optional(),
    estimatedComplexity: zod_1.z.number().nonnegative().optional(),
    confidence: zod_1.z.number().min(0).max(1),
    novel: zod_1.z.boolean(),
    fingerprint: zod_1.z.string().length(64), // SHA256 hex
    generatedAt: zod_1.z.string().datetime(),
    signature: zod_1.z.string().optional(),
});
/** Parse with detailed error messages. Returns Ok/Err discriminated union. */
function parseLesson(raw) {
    const result = exports.LessonV1Schema.safeParse(raw);
    if (result.success)
        return { ok: true, lesson: result.data };
    return { ok: false, errors: result.error.message };
}
//# sourceMappingURL=LessonSchema.js.map