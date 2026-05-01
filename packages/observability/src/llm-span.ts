import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { GENAI, OWEIBO, OPERATION } from './genai.js';
import type { TaskContext } from './agent-span.js';

const tracer = trace.getTracer('oweibo', '0.6.0');

export interface LLMSpanOptions {
  system:       string; // 'ollama' | 'openai' | 'anthropic' | 'deepseek' | 'openrouter'
  model:        string;
  operation:    'chat' | 'embeddings';
  temperature?: number;
  maxTokens?:   number;
  topP?:        number;
}

export interface LLMSpanResult {
  inputTokens?:    number;
  outputTokens?:   number;
  responseModel?:  string;
  responseId?:     string;
  finishReasons?:  string[];
}

/**
 * Wraps a chat or embeddings call in a gen_ai OTel span.
 * Optionally accepts a getResult() extractor to record token counts
 * and other response metadata after the call completes.
 */
export async function withLLMSpan<T>(
  opts:      LLMSpanOptions,
  taskCtx:   TaskContext,
  fn:        () => Promise<T>,
  getResult?: (r: T) => LLMSpanResult,
): Promise<T> {
  return tracer.startActiveSpan(opts.operation, { kind: SpanKind.CLIENT }, async span => {
    span.setAttributes({
      [GENAI.SYSTEM]:          opts.system,
      [GENAI.OPERATION_NAME]:  opts.operation,
      [GENAI.REQUEST_MODEL]:   opts.model,
      [OWEIBO.TENANT_ID]:      taskCtx.tenantId,
      [OWEIBO.USER_ID]:        taskCtx.userId,
      [OWEIBO.TASK_ID]:        taskCtx.taskId,
      ...(opts.temperature != null ? { [GENAI.REQUEST_TEMPERATURE]: opts.temperature } : {}),
      ...(opts.maxTokens   != null ? { [GENAI.REQUEST_MAX_TOKENS]:  opts.maxTokens   } : {}),
      ...(opts.topP        != null ? { [GENAI.REQUEST_TOP_P]:       opts.topP        } : {}),
    });
    try {
      const result = await fn();
      if (getResult) {
        const meta = getResult(result);
        if (meta.inputTokens  != null) span.setAttribute(GENAI.USAGE_INPUT_TOKENS,      meta.inputTokens);
        if (meta.outputTokens != null) span.setAttribute(GENAI.USAGE_OUTPUT_TOKENS,     meta.outputTokens);
        if (meta.responseModel)        span.setAttribute(GENAI.RESPONSE_MODEL,          meta.responseModel);
        if (meta.responseId)           span.setAttribute(GENAI.RESPONSE_ID,             meta.responseId);
        if (meta.finishReasons)        span.setAttribute(GENAI.RESPONSE_FINISH_REASONS, meta.finishReasons);
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
