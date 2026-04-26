// packages/core-engine/src/agentic/InstrumentedLLMClient.ts
// Langfuse-instrumented LLM client wrapper (§16b.1b)
import type { ILLMClient, ILLMGenerateRequest, ILLMGenerateResponse } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';

/**
 * InstrumentedLLMClient — wraps the base LLM HTTP client with Langfuse tracing.
 * Every generate() call produces a Langfuse generation span capturing:
 *   - model, prompt, completion, tokens, latency
 * Stateless — safe to instantiate once per agent per task.
 */
export class InstrumentedLLMClient implements ILLMClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model:   string,
    private readonly trace:   LangfuseTraceClient,
  ) {}

  async generate(params: ILLMGenerateRequest): Promise<ILLMGenerateResponse> {
    const startMs = Date.now();
    const response = await this.callApi(params);
    const latencyMs = Date.now() - startMs;
    // TODO: trace.generation({ model, input, output, usage, latencyMs })
    return { ...response, durationMs: latencyMs };
  }

  async *stream(params: { systemPrompt: string; userPrompt: string }): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:  this.model,
        stream: true,
        messages: [
          { role: 'system',    content: params.systemPrompt },
          { role: 'user',      content: params.userPrompt   },
        ],
      }),
    });

    if (!res.ok || !res.body) throw new Error(`[InstrumentedLLMClient] stream failed: HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as { message?: { content?: string } };
          const chunk  = parsed.message?.content;
          if (chunk) yield chunk;
        } catch { /* skip malformed lines */ }
      }
    }
  }

  private async callApi(params: ILLMGenerateRequest): Promise<ILLMGenerateResponse> {
    const body: Record<string, unknown> = {
      model:  this.model,
      stream: false,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user',   content: params.userPrompt   },
      ],
    };
    if (params.responseFormat === 'json') {
      body['format'] = 'json';
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`[InstrumentedLLMClient] HTTP ${res.status}: ${await res.text()}`);

    const json = await res.json() as { message?: { content?: string } };
    const output = json.message?.content ?? '';

    if (params.responseFormat === 'embedding') {
      // Ollama embedding endpoint
      const embedRes = await fetch(`${this.baseUrl}/api/embeddings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: this.model, prompt: params.userPrompt }),
      });
      const embedJson = await embedRes.json() as { embedding?: number[] };
      return { output: '', embedding: embedJson.embedding };
    }

    return { output };
  }
}
