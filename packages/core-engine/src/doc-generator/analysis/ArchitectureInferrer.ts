import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileAnalysis } from '@oweibo/core-contracts';
import type { ILogger } from './validateGlobPatterns.js';

export type ModulePurpose = 'core' | 'infrastructure' | 'domain' | 'integration' | 'utility' | 'unknown';

export interface ModuleBoundary {
  readonly name:         string;
  /** Absolute path to the package root. */
  readonly rootPath:     string;
  readonly version:      string | undefined;
  /** Whether this package matches a workspace glob (pnpm/lerna). */
  readonly inWorkspace:  boolean;
  /** Confidence in this boundary detection. Lower when not in workspace globs. */
  readonly confidence:   number;
  /** Public API entry points (barrel index.ts files). */
  readonly entryPoints:  readonly string[];
  readonly purpose:      ModulePurpose;
  /** LLM-generated description (empty when skipLLM=true). */
  readonly description:  string;
  readonly fileCount:    number;
  /** Names of other modules this one imports from. */
  readonly dependsOn:    readonly string[];
}

export interface ArchitectureInferrerOptions {
  readonly skipLLM?: boolean;
}

/**
 * ArchitectureInferrer — detects monorepo package boundaries and computes
 * inter-module coupling from import graph heuristics.
 *
 * Heuristic phase (always runs):
 *   - Detect package.json boundaries
 *   - Cross-validate against pnpm-workspace.yaml / lerna.json
 *   - Detect barrel index.ts as public API entry points
 *   - Compute coupling via import graph
 *
 * LLM phase (skipped when skipLLM=true):
 *   - 1–2 sentence module description
 *   - Purpose classification
 */
export class ArchitectureInferrer {
  constructor(
    private readonly logger:  ILogger,
    private readonly options: ArchitectureInferrerOptions = {},
  ) {}

  async infer(
    rootPath: string,
    files:    readonly FileAnalysis[],
    signal?:  AbortSignal,
  ): Promise<readonly ModuleBoundary[]> {
    signal?.throwIfAborted();

    const packageJsonPaths = await this.findPackageJsons(rootPath);
    const workspaceGlobs   = await this.loadWorkspaceGlobs(rootPath);
    const boundaries       = await this.buildBoundaries(packageJsonPaths, workspaceGlobs, files);

    return boundaries;
  }

  private async findPackageJsons(rootPath: string): Promise<string[]> {
    const results: string[] = [];
    const EXCLUDE = /node_modules|\/dist\//;

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 6) return;
      let entries: { name: string; isFile(): boolean; isDirectory(): boolean }[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (EXCLUDE.test(full)) continue;
        if (entry.isFile() && entry.name === 'package.json') {
          results.push(full);
        } else if (entry.isDirectory()) {
          await walk(full, depth + 1);
        }
      }
    }

    await walk(rootPath, 0);
    return results;
  }

  private async loadWorkspaceGlobs(rootPath: string): Promise<string[]> {
    // pnpm-workspace.yaml
    try {
      const raw = await fs.readFile(path.join(rootPath, 'pnpm-workspace.yaml'), 'utf-8');
      const match = raw.match(/packages:\s*([\s\S]*?)(?:\n\w|\n$|$)/);
      if (match) {
        return match[1]!
          .split('\n')
          .map((l) => l.trim().replace(/^-\s*/, '').replace(/['"]/g, ''))
          .filter(Boolean);
      }
    } catch { /* no pnpm-workspace.yaml */ }

    // lerna.json
    try {
      const raw = await fs.readFile(path.join(rootPath, 'lerna.json'), 'utf-8');
      const json = JSON.parse(raw) as { packages?: string[] };
      return json.packages ?? [];
    } catch { /* no lerna.json */ }

    return [];
  }

  private async buildBoundaries(
    packageJsonPaths: readonly string[],
    workspaceGlobs:   readonly string[],
    files:            readonly FileAnalysis[],
  ): Promise<ModuleBoundary[]> {
    const boundaries: ModuleBoundary[] = [];

    for (const pkgJsonPath of packageJsonPaths) {
      const pkgRoot = path.dirname(pkgJsonPath);
      let name = path.basename(pkgRoot);
      let version: string | undefined;

      try {
        const raw = await fs.readFile(pkgJsonPath, 'utf-8');
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        if (pkg.name) name = pkg.name;
        version = pkg.version;
      } catch { /* keep basename fallback */ }

      const inWorkspace = workspaceGlobs.length === 0 ||
        workspaceGlobs.some((g) => this.globMatches(g, pkgRoot));

      const pkgFiles = files.filter((f) => f.filePath.startsWith(pkgRoot));
      const entryPoints = pkgFiles
        .filter((f) => /index\.(ts|tsx|js|mjs)$/.test(f.filePath))
        .map((f) => f.filePath);

      const dependsOn = this.computeDependsOn(pkgFiles, boundaries.map((b) => b.name));

      boundaries.push({
        name,
        rootPath:    pkgRoot,
        version,
        inWorkspace,
        confidence:  inWorkspace ? 0.9 : 0.5,
        entryPoints,
        purpose:     this.inferPurpose(name, pkgFiles),
        description: '',
        fileCount:   pkgFiles.length,
        dependsOn,
      });
    }

    return boundaries;
  }

  private computeDependsOn(pkgFiles: readonly FileAnalysis[], knownModules: readonly string[]): string[] {
    const deps = new Set<string>();
    for (const f of pkgFiles) {
      for (const imp of f.imports) {
        for (const known of knownModules) {
          if (imp.source.includes(known) || imp.source === known) deps.add(known);
        }
      }
    }
    return Array.from(deps);
  }

  private inferPurpose(name: string, files: readonly FileAnalysis[]): ModulePurpose {
    const n = name.toLowerCase();
    if (/infra|database|db|redis|queue|storage|cache/.test(n))   return 'infrastructure';
    if (/domain|model|entity|aggregate/.test(n))                  return 'domain';
    if (/adapter|gateway|client|integration/.test(n))             return 'integration';
    if (/util|helper|common|shared|lib/.test(n))                  return 'utility';
    if (files.some((f) => f.exports.some((s) => s.kind === 'class' && /Service|Orchestrator|Engine/.test(s.name)))) {
      return 'core';
    }
    return 'unknown';
  }

  private globMatches(glob: string, filePath: string): boolean {
    const pattern = glob.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    try {
      return new RegExp(pattern).test(filePath.replace(/\\/g, '/'));
    } catch {
      return false;
    }
  }
}
