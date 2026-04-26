// packages/core-engine/src/general-coding/intelligence/RepoMapBuilder.ts
// Tiered 3k-token repo skeleton — Tier1/2/3 (§16f.7, G14)
import * as ts   from 'typescript';
import * as path from 'path';
import * as fs   from 'fs';

/**
 * RepoMapBuilder — produces a tiered, token-budgeted structural map of the entire repo.
 * Injected as a fixed prefix into every GeneralCodingAgent prompt.
 *
 * G14 fix: Three-tier progressive summarisation strategy.
 * Tier 1 (≤150 source files)  — full export skeleton: class names + all public method signatures.
 * Tier 2 (151–500 source files) — module-boundary summary: file path + exported type names only.
 * Tier 3 (500+ source files)  — directory tree only with file counts per directory.
 *
 * Budget: 12,000 chars (~3,000 tokens) per tier.
 */
export class RepoMapBuilder {
  private static readonly TIER1_MAX_FILES = 150;
  private static readonly TIER2_MAX_FILES = 500;
  private static readonly CHAR_BUDGET     = 12_000;  // ~3k tokens at 4 chars/token

  constructor(private readonly repoRoot: string) {}

  async build(repoRoot?: string): Promise<string> {
    const root       = repoRoot ?? this.repoRoot;
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return this.buildFiletreeOnly(root);

    const config       = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    const program      = ts.createProgram(parsedConfig.fileNames, { ...parsedConfig.options, noEmit: true });

    const sourceFiles = program.getSourceFiles().filter(
      sf => !sf.isDeclarationFile && sf.fileName.startsWith(root),
    );

    const tier = sourceFiles.length <= RepoMapBuilder.TIER1_MAX_FILES ? 1
               : sourceFiles.length <= RepoMapBuilder.TIER2_MAX_FILES ? 2
               : 3;

    return this.buildTiered(root, sourceFiles, tier);
  }

  private buildTiered(root: string, sourceFiles: readonly ts.SourceFile[], tier: 1 | 2 | 3): string {
    if (tier === 3) return this.buildDirectoryTree(root);

    const lines: string[] = [`## Repo Map (Tier ${tier} — ${sourceFiles.length} files)\n`];

    const fileEntries = sourceFiles
      .map(sf => ({
        sf,
        exports: this.extractExports(sf, tier),
        rel:     path.relative(root, sf.fileName),
      }))
      .filter(e => e.exports.length > 0)
      .sort((a, b) => b.exports.length - a.exports.length);

    for (const { rel, exports } of fileEntries) {
      const fileLines = [rel, ...exports.map(e => `  ${e}`)];
      const candidate = lines.join('\n') + '\n' + fileLines.join('\n');
      if (candidate.length > RepoMapBuilder.CHAR_BUDGET) {
        const remaining = fileEntries.length - lines.filter(l => !l.startsWith(' ')).length;
        lines.push(`… (${remaining} more files truncated)`);
        break;
      }
      lines.push(...fileLines);
    }

    return lines.join('\n');
  }

  private buildDirectoryTree(root: string): string {
    const counts = new Map<string, number>();
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const rel = path.relative(root, dir);
          counts.set(rel, (counts.get(rel) ?? 0) + 1);
        }
      }
    };
    walk(root);
    const lines = ['## Repo Map (Tier 3 — directory summary)\n'];
    for (const [dir, count] of [...counts.entries()].sort()) {
      lines.push(`  ${dir || '.'}/  [${count} TS files]`);
    }
    return lines.join('\n');
  }

  private extractExports(sourceFile: ts.SourceFile, tier: 1 | 2 = 1): string[] {
    const exports: string[] = [];

    ts.forEachChild(sourceFile, node => {
      if (!this.isExported(node)) return;

      if (ts.isClassDeclaration(node) && node.name) {
        exports.push(`export class ${node.name.text}`);
        if (tier === 1) {
          node.members.forEach(m => {
            if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && ts.isIdentifier(m.name)) {
              const isPublic = !m.modifiers?.some(
                mod => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword,
              );
              if (isPublic) {
                const sig = m.getText(sourceFile).split('\n')[0]!.slice(0, 80);
                exports.push(`    + ${sig}`);
              }
            }
          });
        }
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const sig = tier === 1
          ? node.getText(sourceFile).split('\n')[0]!.replace(`export function ${node.name.text}`, '')
          : '';
        exports.push(`  export function ${node.name.text}${sig}`);
      } else if (ts.isInterfaceDeclaration(node)) {
        exports.push(`  export interface ${node.name.text}`);
      } else if (ts.isTypeAliasDeclaration(node)) {
        exports.push(`  export type ${node.name.text}`);
      }
    });

    return exports;
  }

  private isExported(node: ts.Node): boolean {
    return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  }

  private buildFiletreeOnly(root: string): string {
    const walk = (dir: string, depth: number): string[] => {
      if (depth > 4) return [];
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return []; }
      return entries.flatMap(e => {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') return [];
        const rel = path.relative(root, path.join(dir, e.name));
        if (e.isDirectory()) return [`${'  '.repeat(depth)}${e.name}/`, ...walk(path.join(dir, e.name), depth + 1)];
        return [`${'  '.repeat(depth)}${e.name}`];
      });
    };
    return `## Repo Map (file tree only — no tsconfig found)\n${walk(root, 0).join('\n')}`;
  }
}
