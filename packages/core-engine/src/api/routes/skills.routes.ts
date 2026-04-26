import { Router, Request, Response, NextFunction } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RemoteSkillFetcher } from '../../general-coding/project/RemoteSkillFetcher.js';

export interface SkillsRouterDeps {
  /** When provided, POST /skills/pull delegates to this fetcher (v9.4.2). */
  readonly fetcher?: RemoteSkillFetcher;
  /** Absolute path to the tenant workspace root (required when fetcher is set). */
  readonly repoRoot?: string;
  /** Tenant id used for per-tenant Vault token lookup (required when fetcher is set). */
  readonly tenantId?: string;
}

interface SkillSource {
  name: string;
  url: string;
  ref?: string;
  integrity?: string;
}

interface SkillsSourcesManifest {
  version: number;
  sources: SkillSource[];
}

interface SkillsLockEntry {
  source: string;
  version: string;
  resolvedAt: string;
  integrity: string;
}

interface SkillsLock {
  version: number;
  lockfileVersion: number;
  skills: Record<string, SkillsLockEntry>;
}

const OWEIBO_DIR = path.resolve(process.cwd(), '.oweibo');
const SOURCES_FILE = path.join(OWEIBO_DIR, 'skills-sources.json');
const LOCK_FILE = path.join(OWEIBO_DIR, 'skills.lock');

async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as T;
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function createSkillsRouter(deps: SkillsRouterDeps = {}): Router {
  const router = Router();
  const { fetcher, repoRoot, tenantId } = deps;

  // GET /skills — list configured sources and their locked state
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [manifest, lock] = await Promise.all([
        readJson<SkillsSourcesManifest>(SOURCES_FILE).catch(() => ({ version: 1, sources: [] })),
        readJson<SkillsLock>(LOCK_FILE).catch(() => ({ version: 1, lockfileVersion: 1, skills: {} })),
      ]);
      res.json({ sources: manifest.sources, locked: lock.skills });
    } catch (err) {
      next(err);
    }
  });

  // GET /skills/:name — retrieve a single resolved skill record
  router.get('/:name', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const lock = await readJson<SkillsLock>(LOCK_FILE).catch(
        () => ({ version: 1, lockfileVersion: 1, skills: {} } as SkillsLock),
      );
      const entry = lock.skills[req.params['name']!];
      if (!entry) {
        res.status(404).json({ error: 'skill_not_found', name: req.params['name']! });
        return;
      }
      res.json({ name: req.params['name']!, ...entry });
    } catch (err) {
      next(err);
    }
  });

  // POST /skills/pull — resolve sources from skills-sources.json into skills.lock.
  // v9.4.2: when a RemoteSkillFetcher is injected, delegate so remote skill
  // content is actually materialised under .oweibo/skills/ rather than just
  // recording resolution metadata in the lockfile.
  router.post('/pull', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (fetcher && repoRoot && tenantId) {
        const count = await fetcher.fetchAll(repoRoot, tenantId);
        const integrity = fetcher.verifyIntegrity(repoRoot);
        res.json({
          pulled: count,
          integrity: { ok: integrity.ok.length, tampered: integrity.tampered.length, unknown: integrity.unknown.length },
        });
        return;
      }

      const manifest = await readJson<SkillsSourcesManifest>(SOURCES_FILE);
      const lock: SkillsLock = {
        version: 1,
        lockfileVersion: 1,
        skills: {},
      };
      const now = new Date().toISOString();
      for (const src of manifest.sources) {
        lock.skills[src.name] = {
          source: src.url,
          version: src.ref ?? 'HEAD',
          resolvedAt: now,
          integrity: src.integrity ?? '',
        };
      }
      await writeJson(LOCK_FILE, lock);
      res.json({ pulled: Object.keys(lock.skills).length, skills: lock.skills });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createSkillsRouter;
