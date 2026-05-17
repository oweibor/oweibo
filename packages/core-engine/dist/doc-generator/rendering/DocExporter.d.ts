import type { RenderedDocument, AnalysisWarning } from '@oweibo/core-contracts';
export interface ExportOptions {
    readonly outputDir: string;
    readonly format?: 'markdown' | 'single-file';
    /** When true, reject any ZIP entry that escapes outputDir (C6, v10.5). */
    readonly strictPaths?: boolean;
}
export interface ExportResult {
    readonly writtenFiles: readonly string[];
    readonly warnings: readonly AnalysisWarning[];
}
/**
 * DocExporter — writes RenderedDocument[] to the filesystem.
 *
 * Zip slip prevention (C6, v10.5): all output paths are path.normalize()'d
 * and asserted to be prefixed by the resolved output root before writing.
 * Any path that escapes the root is dropped with a ZIP_PATH_VIOLATION warning.
 *
 * ADR namespace invariant (B5, v10.4): writes from ADRDocTemplate to docs/adr/
 * are blocked with ADR_NAMESPACE_VIOLATION.
 */
export declare class DocExporter {
    export(documents: readonly RenderedDocument[], options: ExportOptions): Promise<ExportResult>;
    /**
     * exportZip — stream a ZIP archive of `filePaths` to `destStream`.
     *
     * Zip slip prevention (C6): every entry path is validated to be within `outputRoot`
     * before being added. Entries that escape the root are silently skipped.
     *
     * @param filePaths  Absolute paths to include (from a completed session's writtenFiles).
     * @param outputRoot The session's output directory — entries are stored relative to it.
     * @param destStream Writable stream to pipe the ZIP into (e.g. HTTP response).
     */
    exportZip(filePaths: readonly string[], outputRoot: string, destStream: NodeJS.WritableStream): Promise<void>;
}
//# sourceMappingURL=DocExporter.d.ts.map