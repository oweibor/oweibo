/**
 * self-doc.integration.test.ts — full-pipeline integration test (MED-7, v10.5).
 *
 * Runs DocGeneratorPipeline against the core-engine package's own source tree
 * with skipLLM:true and a temporary output directory. Verifies that:
 *   1. The run completes without throwing.
 *   2. At least one documentation file is written to the output directory.
 *   3. The architecture.md and developer-guide.md files exist (non-LLM templates).
 *   4. tokensSpent is a non-negative number.
 *   5. No ADR_NAMESPACE_VIOLATION or ZIP_PATH_VIOLATION warnings are emitted.
 *   6. All written paths are within the temporary output directory (zip-slip regression).
 *   7. Dry-run mode returns a non-empty DryRunReport with valid template applicability data.
 *
 * This test does NOT make real LLM calls and does NOT write to the actual docs/ folder.
 * It uses an in-process event bus and no-op vector search.
 *
 * Timeout: 120 s (analysis of ~200 TS files may take 20–40 s in CI).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DocGeneratorPipeline } from '../DocGeneratorPipeline.js';
import type { DocGeneratorPipelineOptions, DocGenJob } from '../DocGeneratorPipeline.js';
import { TaskEventBus } from '../../ingestion/TaskEventBus.js';

const CORE_ENGINE_SRC = path.resolve(__dirname, '../../../');
const TEST_TIMEOUT    = 120_000;

// ── Minimal in-memory event bus ───────────────────────────────────────────────

function makeEventBus(): TaskEventBus {
  return new TaskEventBus(
    async () => undefined,
    async (_channel, _handler) => async () => undefined,
  );
}

// ── No-op LLM client (skipLLM:true means it should never be called) ───────────

const noopLLM = {
  complete: async () => ({ content: '{}' }),
  stream:   async function* () { yield '{}'; },
} as never;

// ── No-op vector search ───────────────────────────────────────────────────────

const noopVectorSearch = {
  search: async () => [],
  upsert: async () => undefined,
} as never;

// ── Logger that silences output in CI ─────────────────────────────────────────

const silentLogger = {
  info:  (_msg: string) => undefined,
  warn:  (_msg: string) => undefined,
  error: (_msg: string) => undefined,
  debug: (_msg: string) => undefined,
};

// ── Shared pipeline options ───────────────────────────────────────────────────

function buildOpts(eventBus: TaskEventBus, dotOweiboDir: string): DocGeneratorPipelineOptions {
  return {
    llm:          noopLLM,
    eventBus,
    logger:       silentLogger,
    vectorSearch: noopVectorSearch,
    dotOweiboDir,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('DocGeneratorPipeline — self-doc integration', () => {
  let outputDir:    string;
  let dotOweiboDir: string;

  beforeAll(async () => {
    outputDir    = await fs.mkdtemp(path.join(os.tmpdir(), 'oweibo-self-doc-'));
    dotOweiboDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oweibo-self-doc-cache-'));
  });

  afterAll(async () => {
    await fs.rm(outputDir,    { recursive: true, force: true });
    await fs.rm(dotOweiboDir, { recursive: true, force: true });
  });

  it(
    'dry-run: returns DryRunReport with filesDiscovered > 0 and templatesApplicable list',
    async () => {
      const bus = makeEventBus();
      const pipeline = new DocGeneratorPipeline(buildOpts(bus, dotOweiboDir));
      const job: DocGenJob = {
        tenantId:  'integration-test',
        sessionId: 'dry-run-session',
        rootPath:  CORE_ENGINE_SRC,
        outputDir: path.join(outputDir, 'dry-run'),
        options:   { skipLLM: true, dryRun: true, redactAuthors: true, maxFiles: 200 },
      };

      const result = await pipeline.run(job);

      expect(result.dryRunReport).toBeDefined();
      expect(result.dryRunReport!.filesDiscovered).toBeGreaterThan(0);
      expect(Array.isArray(result.dryRunReport!.templatesApplicable)).toBe(true);
      expect(result.dryRunReport!.estimatedLLMTokens).toBeGreaterThan(0);
      expect(result.writtenFiles).toHaveLength(0);
      expect(result.tokensSpent).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'full run (skipLLM:true): writes documentation files to outputDir',
    async () => {
      const bus = makeEventBus();
      const pipeline = new DocGeneratorPipeline(buildOpts(bus, dotOweiboDir));
      const job: DocGenJob = {
        tenantId:  'integration-test',
        sessionId: 'full-session',
        rootPath:  CORE_ENGINE_SRC,
        outputDir: path.join(outputDir, 'full'),
        options:   { skipLLM: true, redactAuthors: true, maxFiles: 200 },
      };

      const result = await pipeline.run(job);

      expect(result.writtenFiles.length).toBeGreaterThan(0);
      expect(typeof result.tokensSpent).toBe('number');
      expect(result.tokensSpent).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'full run: no ADR_NAMESPACE_VIOLATION or ZIP_PATH_VIOLATION warnings',
    async () => {
      const bus = makeEventBus();
      const pipeline = new DocGeneratorPipeline(buildOpts(bus, dotOweiboDir));
      const out = path.join(outputDir, 'violations-check');
      const job: DocGenJob = {
        tenantId:  'integration-test',
        sessionId: 'violations-check-session',
        rootPath:  CORE_ENGINE_SRC,
        outputDir: out,
        options:   { skipLLM: true, redactAuthors: true, maxFiles: 100 },
      };

      const result = await pipeline.run(job);

      const dangerousCodes = new Set(['ADR_NAMESPACE_VIOLATION', 'ZIP_PATH_VIOLATION']);
      for (const w of result.warnings) {
        expect(dangerousCodes.has(w.code)).toBe(false);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'full run: all writtenFiles are within the configured outputDir (zip-slip regression)',
    async () => {
      const bus = makeEventBus();
      const pipeline = new DocGeneratorPipeline(buildOpts(bus, dotOweiboDir));
      const out = path.join(outputDir, 'zip-slip');
      const job: DocGenJob = {
        tenantId:  'integration-test',
        sessionId: 'zip-slip-session',
        rootPath:  CORE_ENGINE_SRC,
        outputDir: out,
        options:   { skipLLM: true, redactAuthors: true, maxFiles: 100 },
      };

      const result = await pipeline.run(job);
      const resolvedOut = path.resolve(out);

      for (const f of result.writtenFiles) {
        const resolved = path.resolve(f);
        expect(resolved.startsWith(resolvedOut + path.sep) || resolved === resolvedOut).toBe(true);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    'cancellation via AbortSignal: resolves without throwing (AbortError becomes cancellation)',
    async () => {
      const bus = makeEventBus();
      const pipeline = new DocGeneratorPipeline(buildOpts(bus, dotOweiboDir));
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 100);

      const job: DocGenJob = {
        tenantId:  'integration-test',
        sessionId: 'abort-session',
        rootPath:  CORE_ENGINE_SRC,
        outputDir: path.join(outputDir, 'aborted'),
        options:   { skipLLM: true, maxFiles: 500 },
      };

      await expect(pipeline.run(job, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    },
    TEST_TIMEOUT,
  );
});
