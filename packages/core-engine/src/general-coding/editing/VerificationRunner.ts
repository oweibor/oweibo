// packages/core-engine/src/general-coding/editing/VerificationRunner.ts
// Tight post-edit verification loop: tsc → eslint → targeted jest (§16f.11, G4)
import type { WarmPoolManager } from '../../sandbox/WarmPoolManager.js';
import type { ISecurityContext } from '@oweibo/core-contracts';
import type { CodeIntelligenceLayer } from '../intelligence/CodeIntelligenceLayer.js';

export interface VerificationResult {
  passed:       boolean;
  errors:       string[];
  typeErrors:   number;
  lintErrors:   number;
  testFailures: number;
  testsRun:     number;
}

/**
 * VerificationRunner — tsc → eslint → targeted jest loop after every edit.
 *
 * Distinct from factory's StaticGateStage/TDDGateStage — operates on the live working tree.
 * "Targeted jest": only test files that transitively import any of the editedFiles are run.
 *
 * v9.1: Uses CodeIntelligenceLayer import graph for accurate test targeting (BFS traversal).
 * All execution routes through WarmPool sandbox — never on the host directly.
 */
export class VerificationRunner {
  constructor(
    private readonly warmPool:  WarmPoolManager,
    private readonly codeIntel: CodeIntelligenceLayer,
  ) {}

  async run(
    repoRoot:    string,
    editedFiles: string[],
    secCtx:      ISecurityContext,
  ): Promise<VerificationResult> {
    const sandbox  = await this.warmPool.acquire(secCtx, { timeoutMs: 30_000 });
    const errors:  string[] = [];
    let typeErrors = 0, lintErrors = 0, testFailures = 0, testsRun = 0;

    try {
      // 1. TypeScript type check
      const tsc = await sandbox.execute(`cd ${repoRoot} && npx tsc --noEmit --pretty false 2>&1`, 'bash');
      if (tsc.exitCode !== 0) {
        const lines = tsc.stdout.split('\n').filter(l => l.includes('error TS'));
        typeErrors  = lines.length;
        errors.push(...lines.map(l => `tsc: ${l.trim()}`).slice(0, 20));
      }

      // 2. ESLint — only on edited files
      if (editedFiles.length > 0) {
        const fileList = editedFiles.map(f => `${repoRoot}/${f}`).join(' ');
        const lint     = await sandbox.execute(
          `cd ${repoRoot} && npx eslint ${fileList} --format compact 2>&1 || true`,
          'bash',
        );
        const lintLines = lint.stdout.split('\n').filter(l => /error/.test(l));
        lintErrors      = lintLines.length;
        errors.push(...lintLines.map(l => `eslint: ${l.trim()}`).slice(0, 10));
      }

      // 3. Targeted jest — v9.1: import graph BFS
      const affectedTests = this.findAffectedTests(repoRoot, editedFiles);
      testsRun            = affectedTests.length;

      if (affectedTests.length > 0) {
        const cappedTests = affectedTests.slice(0, 50);
        if (affectedTests.length > 50) {
          console.warn(`[VerificationRunner] ${affectedTests.length} tests affected — capping at 50`);
        }
        const testPattern = cappedTests.map(t => `--testPathPattern=${t}`).join(' ');
        const jest        = await sandbox.execute(
          `cd ${repoRoot} && npx jest ${testPattern} --no-coverage --passWithNoTests 2>&1`,
          'bash',
        );
        if (jest.exitCode !== 0) {
          const failLines = jest.stdout.split('\n').filter(l => /FAIL |✕ |× /.test(l));
          testFailures    = failLines.length;
          errors.push(...failLines.map(l => `jest: ${l.trim()}`).slice(0, 10));
        }
      }

      return { passed: errors.length === 0, errors, typeErrors, lintErrors, testFailures, testsRun };
    } finally {
      await this.warmPool.release(sandbox);
    }
  }

  /**
   * BFS through the import graph to find all test files that transitively import any edited file.
   */
  private findAffectedTests(repoRoot: string, editedFiles: string[]): string[] {
    const testFilePattern = /\.(test|spec)\.(ts|tsx|js|jsx)$/;
    const affectedTests   = new Set<string>();
    const visited         = new Set<string>();
    const queue           = editedFiles.map(f => `${repoRoot}/${f}`);

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);

      const importers = this.codeIntel.findImporters(file);
      for (const importer of importers) {
        if (testFilePattern.test(importer)) {
          affectedTests.add(importer.replace(`${repoRoot}/`, ''));
        } else if (!visited.has(importer)) {
          queue.push(importer);
        }
      }
    }

    return [...affectedTests];
  }
}
