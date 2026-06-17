/**
 * Internal-only API surface mounted at `/api/v1/_internal/...`.
 *
 * Closes the gap surfaced by the F.5 review: HttpMemoryWriter posts
 * to `/api/v1/_internal/memories/seed` but no route handler existed.
 * Every memory seed POST would 404, leaving tenants marked READY with
 * zero seeded content.
 *
 * Auth: Bearer token compared against OWEIBO_INTERNAL_API_TOKEN via
 * constant-time equality. The internal token is a shared secret only
 * worker processes (tenant-bootstrap-worker, approval-lifecycle-worker)
 * hold; rotating it requires coordinated env-var update across all
 * caller processes.
 *
 * Idempotency: every POST may carry an `idempotency-key` header. If the
 * same key arrives twice within an in-memory TTL window (5 min), the
 * second call returns the cached response without re-applying the
 * mutation. The IdempotencyStore is in-memory by design — a hot
 * server restart loses the window, but the downstream `seed:<seedId>`
 * tag dedup at the memory orchestrator is the durable safety net.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IMemoryOrchestrator, StoreMemoryInput, MemoryKind } from '@oweibo/core-contracts';

export interface InternalRouterOptions {
  readonly internalToken: string;
  readonly memoryOrchestrator: IMemoryOrchestrator;
  /** Override for tests; default keeps idempotency cache 5 min. */
  readonly idempotencyTtlMs?: number;
}

const SeedRequestSchema = z.object({
  tenantId: z.string().uuid(),
  seeds: z.array(z.object({
    seedId: z.string().min(1).max(256),
    catalogVersion: z.string().min(1).max(64),
    kind: z.string().min(1).max(64),
    summary: z.string().min(1).max(8192),
    body: z.string().max(65536).optional(),
    importance: z.number().min(0).max(1),
    tags: z.array(z.string().min(1).max(128)).max(32),
  })).max(100),
});

interface CachedResponse {
  body: unknown;
  status: number;
  expiresAt: number;
}

export function createInternalRouter(opts: InternalRouterOptions): Router {
  if (!opts.internalToken) {
    throw new Error('createInternalRouter: internalToken is required');
  }
  const router = Router();
  const ttlMs = opts.idempotencyTtlMs ?? 5 * 60 * 1000;
  const idempotencyCache = new Map<string, CachedResponse>();

  // ── Auth: constant-time Bearer compare against the internal token ──
  router.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (presented.length === 0 || !constantTimeEquals(presented, opts.internalToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  // ── POST /memories/seed ────────────────────────────────────────────
  router.post('/memories/seed', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Idempotency check — cached response served verbatim.
      const idempotencyKey = req.header('idempotency-key');
      if (idempotencyKey) {
        const now = Date.now();
        // Prune any expired entries lazily.
        for (const [k, v] of idempotencyCache) {
          if (v.expiresAt <= now) idempotencyCache.delete(k);
        }
        const cached = idempotencyCache.get(idempotencyKey);
        if (cached) {
          res.status(cached.status).json(cached.body);
          return;
        }
      }

      const parsed = SeedRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'validation_error',
          details: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
        });
        return;
      }
      const { tenantId, seeds } = parsed.data;

      const inserted: string[] = [];
      const skipped: string[] = [];
      const failed: string[] = [];

      for (const seed of seeds) {
        // Server-side dedup: tag every seed with `seed:<seedId>` and let
        // the memory orchestrator's per-tag store check absorb retries.
        // The orchestrator is responsible for treating `seed:<id>`
        // collisions as no-ops (existing T.2.a contract).
        const tags = uniqueTags([...seed.tags, `seed:${seed.seedId}`, `seed:catalog:${seed.catalogVersion}`]);
        const input: StoreMemoryInput = {
          scope: { tenantId },
          kind: seed.kind as MemoryKind,
          summary: seed.summary,
          ...(seed.body ? { body: seed.body } : {}),
          importance: seed.importance,
          tags,
          detail: { seedId: seed.seedId, catalogVersion: seed.catalogVersion },
        };
        try {
          await opts.memoryOrchestrator.record(input);
          inserted.push(seed.seedId);
        } catch (err) {
          failed.push(`${seed.seedId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const body = { inserted, skipped, failed };
      if (idempotencyKey) {
        idempotencyCache.set(idempotencyKey, { body, status: 200, expiresAt: Date.now() + ttlMs });
      }
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still timing-safe: compare to a buffer of the right length so a
    // length-mismatch attacker can't observe early-exit timing.
    timingSafeEqual(Buffer.from(b), Buffer.from(b));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function uniqueTags(tags: readonly string[]): readonly string[] {
  return Array.from(new Set(tags));
}
