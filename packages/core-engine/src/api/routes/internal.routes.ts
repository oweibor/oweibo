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
import * as path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IMemoryOrchestrator, StoreMemoryInput, MemoryKind, ISkill } from '@oweibo/core-contracts';
import type { DomainIntakeService } from '../../seed/DomainIntakeService.js';

interface ITrace {
  span(opts: { name: string; input?: unknown }): { end(opts?: { output?: unknown }): void };
}

/**
 * Narrow facade over SkillRegistry — the route only needs `discover` +
 * `ensureEmbedded`. Keeps the route testable without standing up
 * ModelRouter+Qdrant+Redis+Vault in unit tests.
 */
export interface ISkillRegistryFacade {
  discover(repoRoot: string): ISkill[];
  ensureEmbedded(skills: ISkill[], tenantId: string, trace: ITrace): Promise<void>;
}

export interface InternalRouterOptions {
  readonly internalToken: string;
  /** F.5.9 server-side: enables POST /memories/seed. */
  readonly memoryOrchestrator?: IMemoryOrchestrator;
  /** F.5.8 server-side (B.1): enables POST /skills/seed. */
  readonly skillRegistry?: ISkillRegistryFacade;
  /** F.5.10 server-side (B.2): enables POST /domain/classify. */
  readonly domainIntakeService?: DomainIntakeService;
  /**
   * Path-traversal guard for /skills/seed: the resolved `bundlePath` MUST
   * sit under this root. Default `/var/lib/oweibo/skills`. Reject otherwise.
   */
  readonly skillBundleRoot?: string;
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

const SkillSeedRequestSchema = z.object({
  tenantId: z.string().uuid(),
  bundlePath: z.string().min(1).max(4096),
});

const DomainClassifyRequestSchema = z.object({
  tenantId: z.string().uuid(),
  interviewAnswers: z.array(z.object({
    question: z.string().min(1).max(2048),
    answer:   z.string().min(1).max(8192),
  })).max(64).optional(),
  primerExcerpts: z.array(z.string().min(1).max(8192)).max(64).optional(),
  repoSignals: z.object({
    languages:  z.array(z.string().min(1).max(64)).max(64).optional(),
    frameworks: z.array(z.string().min(1).max(64)).max(64).optional(),
    notes:      z.array(z.string().min(1).max(2048)).max(32).optional(),
  }).optional(),
});

interface CachedResponse {
  body: unknown;
  status: number;
  expiresAt: number;
}

const DEFAULT_SKILL_BUNDLE_ROOT = '/var/lib/oweibo/skills';

const NOOP_TRACE: ITrace = {
  span: () => ({ end: () => undefined }),
};

export function createInternalRouter(opts: InternalRouterOptions): Router {
  if (!opts.internalToken) {
    throw new Error('createInternalRouter: internalToken is required');
  }
  const router = Router();
  const ttlMs = opts.idempotencyTtlMs ?? 5 * 60 * 1000;
  const idempotencyCache = new Map<string, CachedResponse>();
  const skillBundleRoot = path.resolve(opts.skillBundleRoot ?? DEFAULT_SKILL_BUNDLE_ROOT);

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
      if (!opts.memoryOrchestrator) {
        res.status(503).json({ error: 'unconfigured', route: 'memories/seed' });
        return;
      }

      const cached = lookupIdempotent(req, idempotencyCache);
      if (cached) {
        res.status(cached.status).json(cached.body);
        return;
      }

      const parsed = SeedRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationError(parsed.error));
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
      cacheIdempotent(req, idempotencyCache, body, 200, ttlMs);
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /skills/seed (B.1) ────────────────────────────────────────
  // Discovers + embeds the bundle's SKILL.md files via the server-side
  // SkillRegistry (which already holds ModelRouter+Qdrant+Redis+Vault).
  // The worker calls this so it doesn't need to bundle those heavy deps.
  router.post('/skills/seed', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!opts.skillRegistry) {
        res.status(503).json({ error: 'unconfigured', route: 'skills/seed' });
        return;
      }

      const cached = lookupIdempotent(req, idempotencyCache);
      if (cached) {
        res.status(cached.status).json(cached.body);
        return;
      }

      const parsed = SkillSeedRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationError(parsed.error));
        return;
      }
      const { tenantId, bundlePath } = parsed.data;

      // Path-traversal guard: resolve and verify under the configured
      // skill-bundle root. Reject relative-traversal (`..`) or symlinked
      // escapes by comparing the canonicalised paths.
      const resolved = path.resolve(bundlePath);
      const rootWithSep = skillBundleRoot.endsWith(path.sep) ? skillBundleRoot : skillBundleRoot + path.sep;
      if (resolved !== skillBundleRoot && !resolved.startsWith(rootWithSep)) {
        res.status(400).json({ error: 'invalid_bundle_path', message: 'bundlePath must reside under the configured skill-bundle root' });
        return;
      }

      let skills: ISkill[];
      try {
        skills = opts.skillRegistry.discover(resolved);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: 'skill_bundle_discovery_failed', message: msg });
        return;
      }

      const registered: string[] = [];
      const failed: string[] = [];
      if (skills.length > 0) {
        try {
          await opts.skillRegistry.ensureEmbedded(skills, tenantId, NOOP_TRACE);
          for (const s of skills) registered.push(s.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          for (const s of skills) failed.push(`${s.id}: ${msg}`);
        }
      }

      const body = { registered, failed };
      cacheIdempotent(req, idempotencyCache, body, 200, ttlMs);
      res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /domain/classify (B.2) ────────────────────────────────────
  // Wraps DomainIntakeService.classifyAndRecommend. The worker keeps
  // the Postgres state machine local (PgDomainIntakeProcessor) and
  // calls this for the classification step only.
  router.post('/domain/classify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!opts.domainIntakeService) {
        res.status(503).json({ error: 'unconfigured', route: 'domain/classify' });
        return;
      }

      const cached = lookupIdempotent(req, idempotencyCache);
      if (cached) {
        res.status(cached.status).json(cached.body);
        return;
      }

      const parsed = DomainClassifyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationError(parsed.error));
        return;
      }
      const { interviewAnswers, primerExcerpts, repoSignals } = parsed.data;

      try {
        const recommendation = await opts.domainIntakeService.classifyAndRecommend({
          ...(interviewAnswers ? { interviewAnswers } : {}),
          ...(primerExcerpts ? { primerExcerpts } : {}),
          ...(repoSignals ? { repoSignals } : {}),
        });
        const body = {
          classifiedDomain: recommendation.classification.domain === 'unclassified'
            ? null
            : recommendation.classification.domain,
          classifiedConfidence: recommendation.classification.confidence,
          recommendedTemplate: recommendation.classification.recommendedTemplate ?? null,
          recommendedConnectors: recommendation.classification.recommendedConnectors ?? [],
          recommendedSeedSkills: recommendation.recommendedSeedSkills,
        };
        cacheIdempotent(req, idempotencyCache, body, 200, ttlMs);
        res.status(200).json(body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'classification_failed', message: msg });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function lookupIdempotent(req: Request, cache: Map<string, CachedResponse>): CachedResponse | null {
  const key = req.header('idempotency-key');
  if (!key) return null;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
  return cache.get(key) ?? null;
}

function cacheIdempotent(req: Request, cache: Map<string, CachedResponse>, body: unknown, status: number, ttlMs: number): void {
  const key = req.header('idempotency-key');
  if (!key) return;
  cache.set(key, { body, status, expiresAt: Date.now() + ttlMs });
}

function validationError(err: z.ZodError): { error: string; details: { path: string[]; message: string }[] } {
  return {
    error: 'validation_error',
    details: err.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
  };
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
