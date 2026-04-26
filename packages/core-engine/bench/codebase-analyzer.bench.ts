/**
 * codebase-analyzer.bench.ts — performance harness for CodebaseAnalyzer.
 *
 * Run with: node --experimental-vm-modules bench/codebase-analyzer.bench.ts
 * or via the bench npm script (to be wired in package.json when a bench runner is adopted).
 *
 * Measures:
 *   - walkFs phase duration (file discovery)
 *   - per-file AST analysis throughput (files/sec)
 *   - full analyze() wall-clock time on the large-repo fixture
 *
 * Fixtures: use scripts/gen-large-repo-fixture.ts to generate bench/fixtures/large-repo/
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CodebaseAnalyzer } from '../src/doc-generator/analysis/CodebaseAnalyzer.js';
import { LanguageAnalyzerRegistry } from '../src/doc-generator/analysis/LanguageAnalyzerRegistry.js';
import { TypeScriptAnalyzer } from '../src/doc-generator/analysis/analyzers/TypeScriptAnalyzer.js';
import { GenericAnalyzer } from '../src/doc-generator/analysis/analyzers/GenericAnalyzer.js';
import { PatternDetector } from '../src/doc-generator/analysis/PatternDetector.js';
import { ArchitectureInferrer } from '../src/doc-generator/analysis/ArchitectureInferrer.js';
import { DependencyMapper } from '../src/doc-generator/analysis/DependencyMapper.js';
import { DocAnalyzerCache } from '../src/doc-generator/analysis/DocAnalyzerCache.js';

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'large-repo');
const BENCH_RUNS   = 3;

const nullLogger = {
  info:  () => undefined,
  warn:  () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function bench(): Promise<void> {
  const registry = new LanguageAnalyzerRegistry();
  registry.setFallback(new GenericAnalyzer());
  registry.register(new TypeScriptAnalyzer());

  const cache = await DocAnalyzerCache.create(path.join(FIXTURE_ROOT, '.oweibo'), nullLogger);

  const analyzer = new CodebaseAnalyzer(
    registry,
    new PatternDetector(),
    new ArchitectureInferrer(nullLogger),
    { annotate: async (k: unknown) => k } as never,
    new DependencyMapper(nullLogger),
    cache,
    { complete: async () => ({ content: '' }) } as never,
    nullLogger,
    { publish: async () => undefined, subscribe: () => () => undefined } as never,
    { search: async () => [] } as never,
  );

  const durations: number[] = [];
  for (let i = 0; i < BENCH_RUNS; i++) {
    const start = performance.now();
    const knowledge = await analyzer.analyze(FIXTURE_ROOT, {
      tenantId:      'bench',
      sessionId:     `bench-run-${i}`,
      skipLLM:       true,
      redactAuthors: false,
    });
    const dur = performance.now() - start;
    durations.push(dur);
    console.log(`  Run ${i + 1}: ${dur.toFixed(0)} ms — ${knowledge.files.length} files`);
  }

  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  console.log(`\nCodebaseAnalyzer bench (${BENCH_RUNS} runs):`);
  console.log(`  avg ${avg.toFixed(0)} ms  min ${min.toFixed(0)} ms  max ${max.toFixed(0)} ms`);
}

bench().catch((err) => { console.error(err); process.exitCode = 1; });
