import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { GENAI, OWEIBO, OPERATION } from './genai.js';
import type { TaskContext } from './agent-span.js';

const tracer = trace.getTracer('oweibo', '0.6.0');

export interface ToolSpanOptions {
  toolName: string;
  toolType: 'function' | 'retrieval' | 'code-execution';
  callId?:  string;
}

/**
 * Wraps a ToolRegistry.invoke() call in an execute_tool OTel span.
 * A unique callId is generated if not provided.
 */
export async function withToolSpan<T>(
  opts:    ToolSpanOptions,
  taskCtx: TaskContext,
  fn:      () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(OPERATION.EXECUTE_TOOL, { kind: SpanKind.INTERNAL }, async span => {
    span.setAttributes({
      [GENAI.OPERATION_NAME]: OPERATION.EXECUTE_TOOL,
      [GENAI.TOOL_NAME]:      opts.toolName,
      [GENAI.TOOL_CALL_ID]:   opts.callId ?? randomUUID(),
      [GENAI.TOOL_TYPE]:      opts.toolType,
      [OWEIBO.TENANT_ID]:     taskCtx.tenantId,
      [OWEIBO.USER_ID]:       taskCtx.userId,
      [OWEIBO.TASK_ID]:       taskCtx.taskId,
    });
    try {
      const result = await fn();
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
