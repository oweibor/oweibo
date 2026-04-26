/**
 * Phase 2.5 — Self-host smoke test (A9, v10.3).
 *
 * Runs LanguageAnalyzerRegistry + all three analyzers against the oweibo
 * monorepo's own source tree. Fails fast if the analysis pipeline regresses
 * before Phase 3–7 build-out begins.
 *
 * Constraints (per plan):
 *   - selfMode: true  → analyzed path is the monorepo root itself
 *   - skipLLM: true   → no LLM calls; analysis only
 *   - maxFiles: 200   → cap to keep CI fast
 *   - Must complete within 60 s
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { TypeScriptAnalyzer } from '../analysis/analyzers/TypeScriptAnalyzer.js';
import { PythonAnalyzer } from '../analysis/analyzers/PythonAnalyzer.js';
import { GenericAnalyzer } from '../analysis/analyzers/GenericAnalyzer.js';
import { LanguageAnalyzerRegistry } from '../analysis/LanguageAnalyzerRegistry.js';

const MONOREPO_ROOT = path.resolve(__dirname, '../../../../../');
const MAX_FILES = 200;
const TIMEOUT_MS = 60_000;

const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\/dist\//,
  /\/\.git\//,
  /\/coverage\//,
  /\/\.pnpm\//,
];

async function collectSourceFiles(root: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const INCLUDE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.py', '.go', '.rs', '.java']);

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit) return;
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = path.join(dir, entry.name);
      const posix = full.replace(/\\/g, '/');
      if (EXCLUDE_PATTERNS.some((rx) => rx.test(posix))) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (INCLUDE_EXTS.has(ext)) results.push(full);
      }
    }
  }

  await walk(root);
  return results;
}

describe('Self-doc smoke test — Phase 2.5', () => {
  const registry = new LanguageAnalyzerRegistry();
  const pythonAnalyzer = new PythonAnalyzer();

  beforeAll(() => {
    registry
      .register(new TypeScriptAnalyzer())
      .register(pythonAnalyzer)
      .setFallback(new GenericAnalyzer());
  });

  afterAll(() => {
    pythonAnalyzer.shutdown();
  });

  it(
    `collects ≥ 10 source files from monorepo root (${MONOREPO_ROOT})`,
    async () => {
      const files = await collectSourceFiles(MONOREPO_ROOT, MAX_FILES);
      expect(files.length).toBeGreaterThanOrEqual(10);
    },
    TIMEOUT_MS,
  );

  it(
    'LanguageAnalyzerRegistry.analyzeDirectory handles all collected files without throwing',
    async () => {
      const files = await collectSourceFiles(MONOREPO_ROOT, MAX_FILES);
      const { analyses, skipped } = await registry.analyzeDirectory(MONOREPO_ROOT, files);

      // No files should be completely skipped (registry has a fallback)
      expect(skipped).toHaveLength(0);

      // All returned analyses must have required fields
      for (const analysis of analyses) {
        expect(typeof analysis.filePath).toBe('string');
        expect(typeof analysis.language).toBe('string');
        expect(typeof analysis.lineCount).toBe('number');
        expect(analysis.lineCount).toBeGreaterThanOrEqual(0);
        expect(typeof analysis.complexity).toBe('number');
        expect(analysis.complexity).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(analysis.exports)).toBe(true);
        expect(Array.isArray(analysis.imports)).toBe(true);
        expect(Array.isArray(analysis.dependencies)).toBe(true);
      }

      // Sanity: collected files and returned analyses align
      expect(analyses.length).toBe(files.length);
    },
    TIMEOUT_MS,
  );

  it(
    'TypeScript files in core-engine/src yield non-empty exports',
    async () => {
      const coreEngineSrc = path.join(MONOREPO_ROOT, 'packages', 'core-engine', 'src');
      const allFiles = await collectSourceFiles(coreEngineSrc, 50);
      const tsFiles = allFiles.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
      expect(tsFiles.length).toBeGreaterThan(0);

      const { analyses } = await registry.analyzeDirectory(coreEngineSrc, tsFiles);
      const totalExports = analyses.reduce((n, a) => n + a.exports.length, 0);
      // At minimum the analyzers themselves export classes
      expect(totalExports).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    'every FileAnalysis.filePath matches the original file path',
    async () => {
      const files = await collectSourceFiles(MONOREPO_ROOT, 50);
      const { analyses } = await registry.analyzeDirectory(MONOREPO_ROOT, files);
      const resultPaths = new Set(analyses.map((a) => a.filePath));
      for (const fp of files) {
        expect(resultPaths.has(fp)).toBe(true);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'language field is a known CodeLanguage for all analyses',
    async () => {
      const KNOWN_LANGUAGES = new Set([
        'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'unknown',
      ]);
      const files = await collectSourceFiles(MONOREPO_ROOT, MAX_FILES);
      const { analyses } = await registry.analyzeDirectory(MONOREPO_ROOT, files);
      for (const analysis of analyses) {
        expect(KNOWN_LANGUAGES.has(analysis.language)).toBe(true);
      }
    },
    TIMEOUT_MS,
  );
});
