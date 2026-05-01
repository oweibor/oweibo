import { describe, it, expect } from 'vitest';
import { GENAI, OWEIBO, OPERATION } from '../genai.js';
import { TOKEN_BUCKETS, DURATION_BUCKETS, TTFT_BUCKETS, TPOT_BUCKETS } from '../buckets.js';

describe('GENAI attribute constants', () => {
  it('has required chat span attributes', () => {
    expect(GENAI.SYSTEM).toBe('gen_ai.system');
    expect(GENAI.OPERATION_NAME).toBe('gen_ai.operation.name');
    expect(GENAI.REQUEST_MODEL).toBe('gen_ai.request.model');
    expect(GENAI.RESPONSE_MODEL).toBe('gen_ai.response.model');
    expect(GENAI.USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens');
    expect(GENAI.USAGE_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens');
    expect(GENAI.RESPONSE_FINISH_REASONS).toBe('gen_ai.response.finish_reasons');
  });

  it('has invoke_agent attributes', () => {
    expect(GENAI.AGENT_ID).toBe('gen_ai.agent.id');
    expect(GENAI.AGENT_NAME).toBe('gen_ai.agent.name');
    expect(GENAI.AGENT_DESCRIPTION).toBe('gen_ai.agent.description');
  });

  it('has execute_tool attributes', () => {
    expect(GENAI.TOOL_NAME).toBe('gen_ai.tool.name');
    expect(GENAI.TOOL_CALL_ID).toBe('gen_ai.tool.call.id');
    expect(GENAI.TOOL_TYPE).toBe('gen_ai.tool.type');
  });
});

describe('OWEIBO attribute constants', () => {
  it('has all multi-tenancy attributes', () => {
    expect(OWEIBO.TENANT_ID).toBe('oweibo.tenant.id');
    expect(OWEIBO.USER_ID).toBe('oweibo.user.id');
    expect(OWEIBO.TASK_ID).toBe('oweibo.task.id');
    expect(OWEIBO.RUN_ID).toBe('oweibo.run.id');
    expect(OWEIBO.TRUST_MODE).toBe('oweibo.trust.mode');
    expect(OWEIBO.PRINCIPAL_KIND).toBe('oweibo.principal.kind');
  });

  it('uses oweibo.* namespace', () => {
    for (const v of Object.values(OWEIBO)) {
      expect(v).toMatch(/^oweibo\./);
    }
  });
});

describe('OPERATION constants', () => {
  it('has all four operation names from the GenAI spec', () => {
    expect(OPERATION.CHAT).toBe('chat');
    expect(OPERATION.EMBEDDINGS).toBe('embeddings');
    expect(OPERATION.INVOKE_AGENT).toBe('invoke_agent');
    expect(OPERATION.EXECUTE_TOOL).toBe('execute_tool');
  });
});

describe('histogram buckets', () => {
  const isSorted = (arr: readonly number[]) =>
    [...arr].every((v, i, a) => i === 0 || a[i - 1]! <= v);

  it('TOKEN_BUCKETS is sorted ascending', () => { expect(isSorted(TOKEN_BUCKETS)).toBe(true); });
  it('DURATION_BUCKETS is sorted ascending', () => { expect(isSorted(DURATION_BUCKETS)).toBe(true); });
  it('TTFT_BUCKETS is sorted ascending', () => { expect(isSorted(TTFT_BUCKETS)).toBe(true); });
  it('TPOT_BUCKETS is sorted ascending', () => { expect(isSorted(TPOT_BUCKETS)).toBe(true); });
  it('TOKEN_BUCKETS starts at 0', () => { expect(TOKEN_BUCKETS[0]).toBe(0); });
});
