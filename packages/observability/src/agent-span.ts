import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { GENAI, OWEIBO, OPERATION } from './genai.js';

const tracer = trace.getTracer('oweibo', '0.6.0');

export interface TaskContext {
  tenantId:   string;
  userId:     string;
  taskId:     string;
  runId?:     string;
  trust?:     string;
  principal?: 'user' | 'api_key' | 'agent';
}

/**
 * Wraps a pipeline stage function in an invoke_agent OTel span.
 * All required GenAI + oweibo.* attributes are set automatically.
 * Uses no-op spans when no SDK is initialized (safe in tests).
 */
export async function withAgentSpan<T>(
  agentId: string,
  taskCtx: TaskContext,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(OPERATION.INVOKE_AGENT, { kind: SpanKind.INTERNAL }, async span => {
    span.setAttributes({
      [GENAI.OPERATION_NAME]: OPERATION.INVOKE_AGENT,
      [GENAI.AGENT_ID]:       agentId,
      [OWEIBO.TENANT_ID]:     taskCtx.tenantId,
      [OWEIBO.USER_ID]:       taskCtx.userId,
      [OWEIBO.TASK_ID]:       taskCtx.taskId,
      ...(taskCtx.runId      ? { [OWEIBO.RUN_ID]:         taskCtx.runId      } : {}),
      ...(taskCtx.trust      ? { [OWEIBO.TRUST_MODE]:     taskCtx.trust      } : {}),
      ...(taskCtx.principal  ? { [OWEIBO.PRINCIPAL_KIND]: taskCtx.principal  } : {}),
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
