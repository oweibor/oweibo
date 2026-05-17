import { z } from 'zod';
import type { CanonicalRole } from '@oweibo/core-contracts';
export declare const LessonV1Schema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<"1">;
    taskId: z.ZodString;
    tenantId: z.ZodString;
    role: z.ZodEnum<[CanonicalRole, ...CanonicalRole[]]>;
    slotId: z.ZodString;
    channel: z.ZodString;
    outcome: z.ZodEnum<["success", "failure", "recovery"]>;
    abstractPattern: z.ZodString;
    toolSequence: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    errorClass: z.ZodOptional<z.ZodString>;
    subgoalCount: z.ZodOptional<z.ZodNumber>;
    dependencyEdgeCount: z.ZodOptional<z.ZodNumber>;
    estimatedComplexity: z.ZodOptional<z.ZodNumber>;
    confidence: z.ZodNumber;
    novel: z.ZodBoolean;
    fingerprint: z.ZodString;
    generatedAt: z.ZodString;
    signature: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    taskId: string;
    channel: string;
    slotId: string;
    role: CanonicalRole;
    tenantId: string;
    generatedAt: string;
    confidence: number;
    schemaVersion: "1";
    outcome: "success" | "failure" | "recovery";
    abstractPattern: string;
    novel: boolean;
    fingerprint: string;
    estimatedComplexity?: number | undefined;
    signature?: string | undefined;
    toolSequence?: string[] | undefined;
    errorClass?: string | undefined;
    subgoalCount?: number | undefined;
    dependencyEdgeCount?: number | undefined;
}, {
    taskId: string;
    channel: string;
    slotId: string;
    role: CanonicalRole;
    tenantId: string;
    generatedAt: string;
    confidence: number;
    schemaVersion: "1";
    outcome: "success" | "failure" | "recovery";
    abstractPattern: string;
    novel: boolean;
    fingerprint: string;
    estimatedComplexity?: number | undefined;
    signature?: string | undefined;
    toolSequence?: string[] | undefined;
    errorClass?: string | undefined;
    subgoalCount?: number | undefined;
    dependencyEdgeCount?: number | undefined;
}>;
export type ValidatedLessonV1 = z.infer<typeof LessonV1Schema>;
/** Parse with detailed error messages. Returns Ok/Err discriminated union. */
export declare function parseLesson(raw: unknown): {
    ok: true;
    lesson: ValidatedLessonV1;
} | {
    ok: false;
    errors: string;
};
//# sourceMappingURL=LessonSchema.d.ts.map