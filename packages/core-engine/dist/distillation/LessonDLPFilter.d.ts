export interface DLPResult {
    readonly pass: boolean;
    /** Reasons for rejection (empty when pass === true). */
    readonly rejections: readonly string[];
}
/**
 * Validate that `text` contains no identifiable data.
 * Returns pass=true only when ALL checks pass.
 */
export declare function applyDLPFilter(text: string): DLPResult;
/**
 * Strip known-identifiable patterns from text before the confidentiality
 * classifier runs. Returns the sanitised string.
 * This is a best-effort pre-processor — applyDLPFilter MUST still pass on output.
 */
export declare function sanitise(text: string): string;
//# sourceMappingURL=LessonDLPFilter.d.ts.map