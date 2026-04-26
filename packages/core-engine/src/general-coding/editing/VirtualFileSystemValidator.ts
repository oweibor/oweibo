// packages/core-engine/src/general-coding/editing/VirtualFileSystemValidator.ts
// Pre-flight in-memory TypeScript compilation gate (§16f.9.5, G16)
import { Project, InMemoryFileSystemHost } from 'ts-morph';
import * as fs   from 'fs';
import * as path from 'path';

export interface VfsValidationResult {
  passed:      boolean;
  diagnostics: VfsDiagnostic[];
}

export interface VfsDiagnostic {
  filePath: string;
  line:     number;
  column:   number;
  message:  string;
  code:     number;
}

/**
 * VirtualFileSystemValidator — pre-flight in-memory TypeScript compilation gate.
 *
 * G16 fix: Shifts verification from Post-Write to Pre-Write.
 * Applies proposed diffs to an in-memory VFS and runs ts-morph getPreEmitDiagnostics().
 * No files are written to disk — EditApplicator only runs when this gate passes.
 */
export class VirtualFileSystemValidator {
  constructor(private readonly repoRoot: string) {}

  async validate(filesToChange: string[], proposedContents: Map<string, string>): Promise<VfsValidationResult> {
    const configPath = this.findTsConfig();
    if (!configPath) return { passed: true, diagnostics: [] };

    const vfsHost     = new InMemoryFileSystemHost();
    const resolvedRoot = path.resolve(this.repoRoot);

    // Load existing files for all files in the plan
    for (const filePath of filesToChange) {
      const absPath = path.join(resolvedRoot, filePath);
      try {
        vfsHost.writeFileSync(absPath, fs.readFileSync(absPath, 'utf8'));
      } catch { /* New file — will be populated from proposedContents */ }
    }

    // Apply proposed contents onto the VFS
    for (const [filePath, content] of proposedContents) {
      vfsHost.writeFileSync(path.resolve(this.repoRoot, filePath), content);
    }

    const project = new Project({
      tsConfigFilePath:           configPath,
      fileSystem:                 vfsHost,
      skipAddingFilesFromTsConfig: false,
      compilerOptions:            { noEmit: true, skipLibCheck: true },
    });

    const tsDiagnostics = project.getPreEmitDiagnostics();
    if (tsDiagnostics.length === 0) return { passed: true, diagnostics: [] };

    const diagnostics: VfsDiagnostic[] = tsDiagnostics
      .filter(d => d.getSourceFile() !== undefined)
      .slice(0, 20)
      .map(d => {
        const sf    = d.getSourceFile()!;
        const start = d.getStart() ?? 0;
        const { line, column } = sf.getLineAndColumnAtPos(start);
        return {
          filePath: path.relative(resolvedRoot, sf.getFilePath()),
          line,
          column,
          message:  d.getMessageText().toString(),
          code:     d.getCode(),
        };
      });

    return { passed: false, diagnostics };
  }

  private findTsConfig(): string | null {
    const candidates = [
      path.join(this.repoRoot, 'tsconfig.json'),
      path.join(this.repoRoot, 'tsconfig.base.json'),
    ];
    return candidates.find(c => fs.existsSync(c)) ?? null;
  }
}
