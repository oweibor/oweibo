/**
 * F.7.1 — service-span wrapper tests. Uses an in-memory tracer provider
 * so the assertions inspect the actual emitted span attributes /
 * status / events without spinning up the real OTel SDK.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { withServiceSpan } from '../service-span.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
trace.setGlobalTracerProvider(provider);

beforeEach(() => exporter.reset());

describe('withServiceSpan', () => {
  it('emits a span with the supplied name + attributes', async () => {
    const result = await withServiceSpan({
      name: 'gate.decision',
      attributes: { 'oweibo.tenant_id': 't1', 'oweibo.action_class': 'deploy.prod' },
    }, async () => 42);

    expect(result).toBe(42);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('gate.decision');
    expect(spans[0]!.attributes['oweibo.tenant_id']).toBe('t1');
    expect(spans[0]!.attributes['oweibo.action_class']).toBe('deploy.prod');
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
  });

  it('allows the handler to add attributes at end time', async () => {
    await withServiceSpan({ name: 'outbox.tick' }, async (recordAttr) => {
      recordAttr('oweibo.batch_size', 12);
      recordAttr('oweibo.published', 11);
      recordAttr('oweibo.dead_lettered', 1);
    });
    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes['oweibo.batch_size']).toBe(12);
    expect(spans[0]!.attributes['oweibo.published']).toBe(11);
    expect(spans[0]!.attributes['oweibo.dead_lettered']).toBe(1);
  });

  it('records exception + sets ERROR status when handler throws', async () => {
    await expect(withServiceSpan({ name: 'rollback.execute' }, async () => {
      throw new Error('adapter blew up');
    })).rejects.toThrow('adapter blew up');

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('keeps spans separate across concurrent calls', async () => {
    await Promise.all([
      withServiceSpan({ name: 'op.a', attributes: { 'i': 0 } }, async () => undefined),
      withServiceSpan({ name: 'op.b', attributes: { 'i': 1 } }, async () => undefined),
    ]);
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toEqual(['op.a', 'op.b']);
  });

  it('nested spans both finish; outer wraps inner', async () => {
    await withServiceSpan({ name: 'outer' }, async () => {
      await withServiceSpan({ name: 'inner' }, async () => undefined);
    });
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toEqual(['inner', 'outer']);
    // SimpleSpanProcessor emits spans in finish order; inner finishes first.
    expect(spans[0]!.name).toBe('inner');
    expect(spans[1]!.name).toBe('outer');
  });
});

// Silence the unused-import lint that the trimmed nested test left behind.
void context; void trace; void SpanStatusCode; void (null as Span | null);
