/**
 * LangfuseTracer — Langfuse AI observability integration (§16c).
 *
 * Provides traced LLM client wrappers, span emission for tool calls,
 * and task-level scoring. Falls back to a no-op implementation when
 * Langfuse is not configured (no LANGFUSE_SECRET_KEY in environment).
 */
import type { LangfuseTraceClient } from 'langfuse';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _langfuse: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLangfuseClient(): Promise<any> {
  if (_langfuse) return _langfuse;

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  if (!secretKey || !publicKey) return null;

  try {
    // Dynamic import avoids dual-declaration conflict between CJS/ESM langfuse types
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Langfuse } = require('langfuse') as typeof import('langfuse');
    _langfuse = new Langfuse({
      secretKey,
      publicKey,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
      flushAt: 10,
      flushInterval: 5000,
    });
    return _langfuse;
  } catch {
    return null;
  }
}

function createNoOpTrace(taskId: string): LangfuseTraceClient {
  const noop = () => {};
  const noopSpan = { end: noop, update: noop } as unknown as ReturnType<LangfuseTraceClient['span']>;
  return {
    id: taskId,
    update: noop,
    score: noop,
    span: () => noopSpan,
    generation: () => noopSpan as unknown as ReturnType<LangfuseTraceClient['generation']>,
  } as unknown as LangfuseTraceClient;
}

export async function startAgentTrace(
  taskId: string,
  description: string,
  userId?: string,
): Promise<LangfuseTraceClient> {
  const lf = await getLangfuseClient();
  if (!lf) return createNoOpTrace(taskId);

  try {
    return lf.trace({
      id: taskId,
      name: description,
      userId,
      metadata: { taskId, startedAt: new Date().toISOString() },
    }) as LangfuseTraceClient;
  } catch {
    return createNoOpTrace(taskId);
  }
}

export async function scoreTask(
  trace: LangfuseTraceClient,
  scores: {
    testPassRate?: number;
    planFeasibility?: number;
    tokensEfficiency?: number;
    overallQuality?: number;
  },
): Promise<void> {
  for (const [name, value] of Object.entries(scores)) {
    if (value === undefined) continue;
    try {
      trace.score({ name, value });
    } catch {
      // Non-fatal — observability failure must never break the pipeline
    }
  }
}

export async function tracedToolCall<T>(
  trace: LangfuseTraceClient,
  toolName: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let span: any;
  const startMs = Date.now();
  try {
    span = trace.span({
      name: `tool:${toolName}`,
      input: JSON.stringify(input).slice(0, 1000),
    });
  } catch {
    return fn();
  }

  try {
    const result = await fn();
    span?.end?.({ output: JSON.stringify(result).slice(0, 1000) });
    return result;
  } catch (err) {
    span?.end?.({ output: String(err), level: 'ERROR' });
    throw err;
  } finally {
    void startMs; // consumed via metadata on happy path
  }
}

export async function tracedGeneration<
  T extends { promptTokens?: number; completionTokens?: number; output: string },
>(
  trace: LangfuseTraceClient,
  name: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  fn: () => Promise<T>,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let generation: any;
  try {
    generation = trace.generation({
      name,
      model,
      input: [
        { role: 'system', content: systemPrompt.slice(0, 500) },
        { role: 'user', content: userPrompt.slice(0, 500) },
      ],
    });
  } catch {
    return fn();
  }

  try {
    const result = await fn();
    generation?.end?.({
      output: result.output.slice(0, 1000),
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: (result.promptTokens ?? 0) + (result.completionTokens ?? 0),
      },
    });
    return result;
  } catch (err) {
    generation?.end?.({ output: String(err), level: 'ERROR' });
    throw err;
  }
}

export async function flushTraces(): Promise<void> {
  if (_langfuse) {
    try {
      await _langfuse.flushAsync?.();
    } catch {
      // Non-fatal
    }
  }
}
