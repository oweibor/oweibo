/**
 * audit middleware
 *
 * Writes an oweibo.audit_log row (via appendAudit) after the response is sent.
 * Records outcome based on HTTP status code.
 *
 * Usage:
 *   router.post('/tasks', authenticate(...), requireScopes('tasks:write'), audit('task.create'), handler)
 */
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { appendAudit } from '@oweibo/db';
import type { Request, Response, NextFunction } from 'express';

export function audit(action: string, opts: { resourceType?: string } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();

    res.on('finish', () => {
      const principal = (req as any).principal;
      if (!principal) return; // unauthenticated requests are not audited

      const outcome: 'allow' | 'deny' | 'error' =
        res.statusCode < 400 ? 'allow'
        : res.statusCode < 500 ? 'deny'
        : 'error';

      void appendAudit({
        id:              randomUUID(),
        ts:              new Date(started),
        actorPrincipal:  principal.sub,
        onBehalfOfUserId: principal.actAs?.sub,
        source:          detectSource(req),
        requestId:       (req as any).requestId,
        ip:              req.ip,
        tenantId:        principal.ctx?.tenantId,
        scopeUsed:       principal.scopes,
        action,
        resourceType:    opts.resourceType,
        resourceId:      extractResourceId(req),
        outcome,
        details: {
          method:     req.method,
          path:       req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - started,
        },
      }).catch(() => undefined); // non-fatal: never block the response path
    });

    next();
  };
}

function detectSource(req: Request): 'cli' | 'web' | 'api' | 'system' {
  const ua = req.headers['user-agent'] ?? '';
  if (ua.startsWith('oweibo-cli/')) return 'cli';
  if (ua.startsWith('Mozilla/') || ua.startsWith('oweibo-web/')) return 'web';
  return 'api';
}

function extractResourceId(req: Request): string | undefined {
  // Use the last path segment if it looks like a UUID
  const parts = req.path.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  return /^[0-9a-f-]{36}$/.test(last) ? last : undefined;
}

/**
 * snapshotHash — helper used by handlers to compute before/after hashes for
 * state-mutation audit rows. Passed as details rather than being a middleware
 * concern, since the handler owns the before/after state.
 */
export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
