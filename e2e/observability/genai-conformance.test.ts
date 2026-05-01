/**
 * Static CI conformance tests for GenAI OTel instrumentation.
 * Reads files from the monorepo and asserts structural invariants —
 * no running services required.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

describe('GenAI OTel semantic-convention conformance', () => {
  it('CONVENTIONS_VERSION file exists and contains a semver string', () => {
    const path = resolve(ROOT, 'packages/observability/CONVENTIONS_VERSION');
    expect(existsSync(path), 'CONVENTIONS_VERSION file missing').toBe(true);
    const version = readFileSync(path, 'utf-8').trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/, `expected semver, got "${version}"`);
  });

  it('all required GenAI semantic attribute keys are present in genai.ts', () => {
    const src = read('packages/observability/src/genai.ts');
    const required = [
      'gen_ai.system',
      'gen_ai.operation.name',
      'gen_ai.request.model',
      'gen_ai.response.model',
      'gen_ai.usage.input_tokens',
      'gen_ai.usage.output_tokens',
      'gen_ai.agent.id',
      'gen_ai.tool.name',
      'gen_ai.tool.call.id',
    ];
    for (const key of required) {
      expect(src, `missing required attribute: ${key}`).toContain(key);
    }
  });

  it('oweibo multi-tenancy attributes are defined', () => {
    const src = read('packages/observability/src/genai.ts');
    expect(src).toContain('oweibo.tenant.id');
    expect(src).toContain('oweibo.user.id');
    expect(src).toContain('oweibo.task.id');
    expect(src).toContain('oweibo.run.id');
    expect(src).toContain('oweibo.trust.mode');
  });

  it('otelcol strips gen_ai message content (PII policy §15.6.1.4)', () => {
    const cfg = read('infra/observability/otelcol-config.yaml');
    // The attributes/strip-content processor must delete both fields
    expect(cfg).toContain('gen_ai.prompt');
    expect(cfg).toContain('gen_ai.completion');
    expect(cfg).toContain('delete');
    // Verify the processor is wired into the traces pipeline
    expect(cfg).toContain('attributes/strip-content');
  });

  it('tail-sampling policy captures 100% of error spans', () => {
    const cfg = read('infra/observability/otelcol-config.yaml');
    expect(cfg).toContain('status_code');
    expect(cfg).toContain('ERROR');
    expect(cfg).toContain('probabilistic');
    // Errors policy must be listed before the probabilistic fallback
    const errorIdx  = cfg.indexOf('errors-policy');
    const probIdx   = cfg.indexOf('success-sample');
    expect(errorIdx).toBeLessThan(probIdx);
  });

  it('ESLint no-direct-llm-call rule file exists and covers all providers', () => {
    const path = resolve(ROOT, 'scripts/eslint-rules/no-direct-llm-call.js');
    expect(existsSync(path), 'no-direct-llm-call.js rule missing').toBe(true);
    const src = readFileSync(path, 'utf-8');
    const providers = ['OllamaClient', 'OpenAIClient', 'AnthropicClient', 'DeepSeekClient', 'OpenRouterClient'];
    for (const provider of providers) {
      expect(src, `rule does not cover provider: ${provider}`).toContain(provider);
    }
  });

  it('dep-cruiser blocks direct LLM provider imports outside BaseLLMClient', () => {
    const cfg = read('.dependency-cruiser.js');
    expect(cfg).toContain('no-direct-llm-provider-outside-base-client');
    expect(cfg).toContain('observability-cannot-import-business-logic');
  });

  it('Grafana datasource provisioning wires Tempo → Loki trace correlation', () => {
    const cfg = read('infra/observability/grafana/provisioning/datasources/oweibo.yaml');
    expect(cfg).toContain('tracesToLogsV2');
    expect(cfg).toContain('datasourceUid: loki');
    expect(cfg).toContain('oweibo.tenant.id');
  });
});
