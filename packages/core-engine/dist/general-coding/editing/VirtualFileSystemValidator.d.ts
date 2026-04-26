export interface VfsValidationResult {
    passed: boolean;
    diagnostics: VfsDiagnostic[];
}
export interface VfsDiagnostic {
    filePath: string;
    line: number;
    column: number;
    message: string;
    code: number;
}
/**
 * VirtualFileSystemValidator — pre-flight in-memory TypeScript compilation gate.
 *
 * G16 fix: Shifts verification from Post-Write to Pre-Write.
 * Applies proposed diffs to an in-memory VFS and runs ts-morph getPreEmitDiagnostics().
 * No files are written to disk — EditApplicator only runs when this gate passes.
 */
export declare class VirtualFileSystemValidator {
    private readonly repoRoot;
    constructor(repoRoot: string);
    validate(filesToChange: string[], proposedContents: Map<string, string>): Promise<VfsValidationResult>;
    private findTsConfig;
}
//# sourceMappingURL=VirtualFileSystemValidator.d.ts.map