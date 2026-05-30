/**
 * F.7.1 (ttv-finals): generic service-side OTel span wrapper for non-
 * LLM/agent code paths (gate decisions, outbox ticks, worker handlers,
 * adapter operations).
 *
 * Distinct from withAgentSpan / withLLMSpan / withToolSpan because those
 * carry GenAI-spec attributes; this one just emits a plain INTERNAL span
 * with the supplied attribute bag. Use it to satisfy F.7.1 acceptance:
 * "Every gate decision emits a span with attributes
 *  tenant_id, action_class, mode, reason."
 *
 * Span outcomes: status=OK on resolve, status=ERROR + recordException
 * on throw. The original throw is re-raised so callers see the same
 * failure shape.
 */
import { trace, SpanKind, SpanStatusCode, type SpanAttributes } from '@opentelemetry/api';

const tracer = trace.getTracer('oweibo-services', '0.6.0');

export interface ServiceSpanOptions {
  /** Span name. Convention: `<service>.<operation>` (e.g. `gate.decision`). */
  readonly name: string;
  /** Attribute bag attached at span start. */
  readonly attributes?: SpanAttributes;
  /** Optional span kind override. Default INTERNAL. */
  readonly kind?: SpanKind;
}

/**
 * Wraps an async operation in a service-side span. The handler may
 * optionally return attributes to merge in at end time (useful for
 * recording outcome counts like batch_size, dispatched, etc. that
 * aren't known at span start).
 */
export async function withServiceSpan<T>(
  opts: ServiceSpanOptions,
  fn: (recordAttr: (k: string, v: string | number | boolean) => void) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(opts.name, { kind: opts.kind ?? SpanKind.INTERNAL }, async (span) => {
    if (opts.attributes) span.setAttributes(opts.attributes);
    try {
      const result = await fn((k, v) => span.setAttribute(k, v));
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
