/**
 * idempotent middleware
 *
 * Redis-backed Idempotency-Key support for state-mutating POST/DELETE routes.
 *
 * Behaviour:
 *   - First request: execute handler, cache status + body for ttlSeconds
 *   - Replay (same key + same body hash): return cached response immediately
 *   - Same key + different body: 409 idempotency_mismatch
 *
 * The Redis client is injected so callers can reuse their existing connection.
 *
 * Usage:
 *   router.post('/tasks', authenticate(...), idempotent({ redis, ttl: 86400 }), handler)
 */
import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
}

export interface IdempotentOpts {
  redis: RedisLike;
  /** Key TTL in seconds (default 86400 = 24 h) */
  ttl?: number;
  /** Header name (default Idempotency-Key) */
  header?: string;
}

interface CachedEntry {
  bodyHash:   string;
  status:     number;
  body:       unknown;
  cachedAt:   string;
}

export function idempotent({ redis, ttl = 86_400, header = 'idempotency-key' }: IdempotentOpts) {
  return async function idempotentMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = req.headers[header] as string | undefined;
    if (!key) { next(); return; }

    const principal  = (req as any).principal;
    const tenantId   = principal?.ctx?.tenantId ?? 'anon';
    const storeKey   = `idem:${tenantId}:${key}`;
    const bodyHash   = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

    const cached = await redis.get(storeKey);
    if (cached) {
      const entry = JSON.parse(cached) as CachedEntry;
      if (entry.bodyHash !== bodyHash) {
        res.status(409).json({ error: 'idempotency_mismatch', message: 'Idempotency-Key reused with a different request body' });
        return;
      }
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(entry.status).json(entry.body);
      return;
    }

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      if (res.statusCode < 500) {
        void redis.set(storeKey, JSON.stringify({ bodyHash, status: res.statusCode, body, cachedAt: new Date().toISOString() } satisfies CachedEntry), 'EX', ttl)
          .catch(() => undefined);
      }
      return originalJson(body);
    };

    next();
  };
}
