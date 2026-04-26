/**
 * ILanguageAnalyzerContractSuite (C18, v10.5)
 *
 * Shared contract test suite for ILanguageAnalyzer implementations.
 * Export from @oweibo/core-contracts so third-party plugin authors can verify
 * compliance without writing their own fixture harness.
 *
 * Usage:
 *   import { describeILanguageAnalyzerContract } from '@oweibo/core-contracts/testing';
 *
 *   describeILanguageAnalyzerContract(new MyLanguageAnalyzer(), {
 *     filePath: 'fixture.ts',
 *     content:  'export const x = 1;',
 *     language: 'typescript',
 *   });
 *
 * Built-in analyzers (TypeScriptAnalyzer, PythonAnalyzer, GenericAnalyzer) each
 * call this suite in their own test files — there is no separate internal path.
 */

import type { ILanguageAnalyzer } from '../interfaces/ILanguageAnalyzer.js';
import type { CodeLanguage } from '../types/CodebaseKnowledge.js';

export interface LanguageAnalyzerContractFixture {
  /** Relative file path (used as identifier — does not need to exist on disk). */
  filePath: string;
  /** Raw source content to analyze. */
  content:  string;
  /** Expected language classification for this fixture. */
  language: CodeLanguage;
}

/**
 * Call inside a describe block to run the full contract suite against impl.
 * Expects Jest globals (describe, it, expect) — works with ts-jest.
 */
export function describeILanguageAnalyzerContract(
  impl:    ILanguageAnalyzer,
  fixture: LanguageAnalyzerContractFixture,
): void {
  describe('ILanguageAnalyzer contract', () => {
    it('analyzeFile returns FileAnalysis with required fields', async () => {
      const result = await impl.analyzeFile(fixture.filePath, fixture.content);
      expect(result).toBeDefined();
      expect(typeof result.filePath).toBe('string');
      expect(result.filePath).toBe(fixture.filePath);
      expect(typeof result.language).toBe('string');
      expect(typeof result.lineCount).toBe('number');
      expect(result.lineCount).toBeGreaterThanOrEqual(0);
      expect(typeof result.complexity).toBe('number');
      expect(result.complexity).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.exports)).toBe(true);
      expect(Array.isArray(result.imports)).toBe(true);
      expect(Array.isArray(result.dependencies)).toBe(true);
    });

    it('analyzeFile respects AbortSignal — throws on already-aborted signal', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        impl.analyzeFile(fixture.filePath, fixture.content, controller.signal),
      ).rejects.toThrow();
    });

    it('analyzeDirectory returns same file count as N × analyzeFile', async () => {
      const dir = impl.analyzeDirectory(fixture.filePath.split('/').slice(0, -1).join('/') || '.', [fixture.filePath]);
      const single = impl.analyzeFile(fixture.filePath, fixture.content);
      const [dirResults, singleResult] = await Promise.all([dir, single]);
      expect(dirResults).toHaveLength(1);
      expect(dirResults[0]!.filePath).toBe(singleResult.filePath);
    });

    it('extractCallGraph returns EnrichedCallEdge[] (may be empty, not undefined)', async () => {
      const files = await impl.analyzeDirectory('.', [fixture.filePath]);
      const edges = await impl.extractCallGraph(files);
      expect(Array.isArray(edges)).toBe(true);
    });

    it('extractSymbols returns SymbolInfo[] with non-empty name and filePath', () => {
      // Use a minimal pre-built FileAnalysis so we can call synchronously
      const fakeFile = {
        filePath:     fixture.filePath,
        language:     fixture.language,
        lineCount:    1,
        complexity:   1,
        exports:      [],
        imports:      [],
        dependencies: [],
      };
      const symbols = impl.extractSymbols([fakeFile]);
      expect(Array.isArray(symbols)).toBe(true);
      for (const sym of symbols) {
        expect(sym.name.length).toBeGreaterThan(0);
        expect(sym.filePath.length).toBeGreaterThan(0);
      }
    });

    it('does not throw on empty file content', async () => {
      await expect(impl.analyzeFile(fixture.filePath, '')).resolves.toBeDefined();
    });

    it('does not throw on binary-ish content (null bytes)', async () => {
      const binaryish = '\x00\x01\x02\x03\xFF\xFE';
      await expect(impl.analyzeFile(fixture.filePath, binaryish)).resolves.toBeDefined();
    });
  });
}
