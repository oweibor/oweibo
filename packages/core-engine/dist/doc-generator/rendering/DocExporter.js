"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocExporter = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
const archiver_1 = __importDefault(require("archiver"));
const paths_js_1 = require("./templates/paths.js");
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
class DocExporter {
    async export(documents, options) {
        const outputRoot = node_path_1.default.resolve(options.outputDir);
        const warnings = [];
        const writtenFiles = [];
        await promises_1.default.mkdir(outputRoot, { recursive: true });
        for (const doc of documents) {
            const absPath = node_path_1.default.resolve(outputRoot, doc.fileName);
            const canonical = node_path_1.default.normalize(absPath);
            // Zip slip guard (C6)
            if (!canonical.startsWith(outputRoot + node_path_1.default.sep) && canonical !== outputRoot) {
                warnings.push({
                    code: 'ZIP_PATH_VIOLATION',
                    message: `Output path escapes root: ${doc.fileName}`,
                    context: { fileName: doc.fileName, outputRoot },
                });
                continue;
            }
            // ADR namespace guard (B5): inferred ADRs must target docs/adr-inferred/ only.
            // The outer `&&` is on category so non-ADR docs are never evaluated.
            const relParts = node_path_1.default.relative(outputRoot, canonical).split(node_path_1.default.sep);
            if (doc.category === 'adr' &&
                relParts.includes('adr') &&
                !relParts.includes(paths_js_1.ADR_INFERRED_DIR)) {
                warnings.push({
                    code: 'ADR_NAMESPACE_VIOLATION',
                    message: `ADRDocTemplate attempted to write outside adr-inferred/: ${doc.fileName}`,
                    context: { fileName: doc.fileName },
                });
                continue;
            }
            await promises_1.default.mkdir(node_path_1.default.dirname(canonical), { recursive: true });
            await promises_1.default.writeFile(canonical, doc.rendered, 'utf-8');
            writtenFiles.push(canonical);
            // ADR per-file expansion (HIGH-3): write non-README sections as individual files.
            if (doc.category === 'adr') {
                for (const section of doc.sections) {
                    if (section.id === 'readme')
                        continue;
                    const secPath = node_path_1.default.resolve(outputRoot, `docs/${paths_js_1.ADR_INFERRED_DIR}/${section.id}.md`);
                    const secCanon = node_path_1.default.normalize(secPath);
                    if (!secCanon.startsWith(outputRoot + node_path_1.default.sep)) {
                        warnings.push({
                            code: 'ZIP_PATH_VIOLATION',
                            message: `ADR section path escapes root: ${section.id}`,
                            context: { sectionId: section.id },
                        });
                        continue;
                    }
                    await promises_1.default.mkdir(node_path_1.default.dirname(secCanon), { recursive: true });
                    await promises_1.default.writeFile(secCanon, section.content, 'utf-8');
                    writtenFiles.push(secCanon);
                }
            }
        }
        return { writtenFiles, warnings };
    }
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
    async exportZip(filePaths, outputRoot, destStream) {
        const resolvedRoot = node_path_1.default.resolve(outputRoot);
        const archive = (0, archiver_1.default)('zip', { zlib: { level: 6 } });
        await new Promise((resolve, reject) => {
            archive.on('error', reject);
            destStream.on('error', reject);
            destStream.on('finish', resolve);
            destStream.on('close', resolve);
            archive.pipe(destStream);
            for (const absPath of filePaths) {
                const canonical = node_path_1.default.resolve(absPath);
                // Zip slip guard — skip any path that escapes outputRoot
                if (!canonical.startsWith(resolvedRoot + node_path_1.default.sep) && canonical !== resolvedRoot) {
                    continue;
                }
                const entryName = node_path_1.default.relative(resolvedRoot, canonical).replace(/\\/g, '/');
                archive.append((0, node_fs_1.createReadStream)(canonical), { name: entryName });
            }
            void archive.finalize();
        });
    }
}
exports.DocExporter = DocExporter;
//# sourceMappingURL=DocExporter.js.map