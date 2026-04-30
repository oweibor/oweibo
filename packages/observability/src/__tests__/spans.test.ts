/**
 * Span helpers work against the OTel no-op tracer when no SDK is initialized,
 * so no SDK setup is needed in these tests.
 */
import { describe, it, expect } from 'vitest';
import { withAgentSpan, withLLMSpan, withToolSpan } from '../index.js';

const ctx = { tenantId: 't-1', userId: 'u-1', taskId: 'task-abc' };

describe('withAgentSpan', () => {
  it('returns the value from fn', async () => {
    const result = await withAgentSpan('architect', ctx, () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('propagates errors from fn', async () => {
    await expect(
      withAgentSpan('architect', ctx, () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
  });

  it('accepts optional taskCtx fields', async () => {
    const extCtx = { ...ctx, runId: 'run-1', trust: 'graduated', principal: 'user' as const };
    const result = await withAgentSpan('writer-1', extCtx, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });
});

describe('withLLMSpan', () => {
  const opts = { system: 'ollama', model: 'qwen2.5-coder:3b', operation: 'chat' as const };

  it('returns the value from fn', async () => {
    const result = await withLLMSpan(opts, ctx, () => Promise.resolve('the-text'));
    expect(result).toBe('the-text');
  });

  it('propagates errors from fn', async () => {
    await expect(
      withLLMSpan(opts, ctx, () => Promise.reject(new Error('llm-fail')))
    ).rejects.toThrow('llm-fail');
  });

  it('calls getResult extractor when provided', async () => {
    let captured: unknown;
    const result = await withLLMSpan(
      opts, ctx,
      () => Promise.resolve({ text: 'hi', tokens: { input: 10, output: 5 } }),
      (r) => { captured = r; return { inputTokens: r.tokens.input, outputTokens: r.tokens.output }; },
    );
    expect(result.text).toBe('hi');
    expect((captured as any).tokens.input).toBe(10);
  });

  it('works for embeddings operation', async () => {
    const embOpts = { system: 'ollama', model: 'nomic-embed-text', operation: 'embeddings' as const };
    const vec = await withLLMSpan(embOpts, ctx, () => Promise.resolve([0.1, 0.2, 0.3]));
    expect(vec).toHaveLength(3);
  });
});

describe('withToolSpan', () => {
  const opts = { toolName: 'git_commit', toolType: 'function' as const };

  it('returns the value from fn', async () => {
    const result = await withToolSpan(opts, ctx, () => Promise.resolve({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('propagates errors from fn', async () => {
    await expect(
      withToolSpan(opts, ctx, () => Promise.reject(new Error('tool-fail')))
    ).rejects.toThrow('tool-fail');
  });

  it('accepts an explicit callId', async () => {
    const result = await withToolSpan(
      { ...opts, callId: 'my-call-id' }, ctx, () => Promise.resolve('done')
    );
    expect(result).toBe('done');
  });
});
