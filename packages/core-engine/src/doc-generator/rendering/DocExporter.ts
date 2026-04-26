import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import archiver from 'archiver';
import type { RenderedDocument, AnalysisWarning } from '@oweibo/core-contracts';
import { ADR_INFERRED_DIR } from './templates/paths.js';

export interface ExportOptions {
  readonly outputDir:   string;
  readonly format?:     'markdown' | 'single-file';
  /** When true, reject any ZIP entry that escapes outputDir (C6, v10.5). */
  readonly strictPaths?: boolean;
}

export interface ExportResult {
  readonly writtenFiles: readonly string[];
  readonly warnings:     readonly AnalysisWarning[];
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
export class DocExporter {
  async export(
    documents:  readonly RenderedDocument[],
    options:    ExportOptions,
  ): Promise<ExportResult> {
    const outputRoot = path.resolve(options.outputDir);
    const warnings:     AnalysisWarning[] = [];
    const writtenFiles: string[] = [];

    await fs.mkdir(outputRoot, { recursive: true });

    for (const doc of documents) {
      const absPath = path.resolve(outputRoot, doc.fileName);
      const canonical = path.normalize(absPath);

      // Zip slip guard (C6)
      if (!canonical.startsWith(outputRoot + path.sep) && canonical !== outputRoot) {
        warnings.push({
          code:    'ZIP_PATH_VIOLATION',
          message: `Output path escapes root: ${doc.fileName}`,
          context: { fileName: doc.fileName, outputRoot },
        });
        continue;
      }

      // ADR namespace guard (B5): inferred ADRs must target docs/adr-inferred/ only.
      // The outer `&&` is on category so non-ADR docs are never evaluated.
      const relParts = path.relative(outputRoot, canonical).split(path.sep);
      if (
        doc.category === 'adr' &&
        relParts.includes('adr') &&
        !relParts.includes(ADR_INFERRED_DIR)
      ) {
        warnings.push({
          code:    'ADR_NAMESPACE_VIOLATION',
          message: `ADRDocTemplate attempted to write outside adr-inferred/: ${doc.fileName}`,
          context: { fileName: doc.fileName },
        });
        continue;
      }

      await fs.mkdir(path.dirname(canonical), { recursive: true });
      await fs.writeFile(canonical, doc.rendered, 'utf-8');
      writtenFiles.push(canonical);

      // ADR per-file expansion (HIGH-3): write non-README sections as individual files.
      if (doc.category === 'adr') {
        for (const section of doc.sections) {
          if (section.id === 'readme') continue;
          const secPath   = path.resolve(outputRoot, `docs/${ADR_INFERRED_DIR}/${section.id}.md`);
          const secCanon  = path.normalize(secPath);
          if (!secCanon.startsWith(outputRoot + path.sep)) {
            warnings.push({
              code:    'ZIP_PATH_VIOLATION',
              message: `ADR section path escapes root: ${section.id}`,
              context: { sectionId: section.id },
            });
            continue;
          }
          await fs.mkdir(path.dirname(secCanon), { recursive: true });
          await fs.writeFile(secCanon, section.content, 'utf-8');
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
  async exportZip(
    filePaths:   readonly string[],
    outputRoot:  string,
    destStream:  NodeJS.WritableStream,
  ): Promise<void> {
    const resolvedRoot = path.resolve(outputRoot);
    const archive = archiver('zip', { zlib: { level: 6 } });

    await new Promise<void>((resolve, reject) => {
      archive.on('error', reject);
      destStream.on('error', reject);
      destStream.on('finish', resolve);
      destStream.on('close', resolve);

      archive.pipe(destStream as import('node:stream').Writable);

      for (const absPath of filePaths) {
        const canonical = path.resolve(absPath);
        // Zip slip guard — skip any path that escapes outputRoot
        if (!canonical.startsWith(resolvedRoot + path.sep) && canonical !== resolvedRoot) {
          continue;
        }
        const entryName = path.relative(resolvedRoot, canonical).replace(/\\/g, '/');
        archive.append(createReadStream(canonical), { name: entryName });
      }

      void archive.finalize();
    });
  }
}
