/**
 * requestId middleware
 *
 * Generates or forwards a correlation ID on every request, and propagates
 * the W3C traceparent header so downstream services (Qdrant, Ollama,
 * Crawl4AI, NATS) can be correlated in Tempo / Langfuse.
 *
 * Attach early — before authenticate — so every log line from auth failures
 * onwards carries the same requestId.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';

/** Regex for W3C traceparent: version-traceId-parentId-flags */
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
  (req as any).requestId = id;
  res.setHeader('x-request-id', id);

  // Forward or generate W3C traceparent
  const incoming = req.headers['traceparent'] as string | undefined;
  if (incoming && TRACEPARENT_RE.test(incoming)) {
    (req as any).traceparent = incoming;
  } else {
    // Synthesise a traceparent from the requestId so downstream spans can link back
    const traceId  = id.replace(/-/g, '').padEnd(32, '0').slice(0, 32);
    const parentId = id.replace(/-/g, '').slice(0, 16);
    (req as any).traceparent = `00-${traceId}-${parentId}-01`;
  }
  res.setHeader('traceparent', (req as any).traceparent);

  next();
}

/** Build headers to forward to downstream HTTP calls (Ollama, Qdrant, Crawl4AI). */
export function propagationHeaders(req: Request): Record<string, string> {
  const r = req as any;
  const headers: Record<string, string> = {};
  if (r.requestId)   headers['x-request-id'] = r.requestId;
  if (r.traceparent) headers['traceparent']   = r.traceparent;
  return headers;
}
