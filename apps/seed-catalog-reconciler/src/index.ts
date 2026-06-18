/**
 * T.7: seed-catalog-reconciler entry point.
 *
 * Daily cron at 04:00 UTC by default. The catalog provider reads the
 * platform seed catalog from the in-repo location and computes content
 * hashes per the T.7 normalisation.
 *
 * Env:
 *   DATABASE_URL — required
 *   SEED_CATALOG_RECONCILE_CRON — cron expression (default '0 4 * * *')
 *   SEED_CATALOG_AUTO_INSTALL_ADDITIVE — when 'true', additive diffs are
 *     marked installed automatically; otherwise they sit in the pending
 *     queue for tenant-admin approval.
 *   SEED_CATALOG_VERSIONING_ENABLED — when 'false', the reconciler runs
 *     but the isAllowed gate short-circuits (no DB writes).
 */
import { Pool } from 'pg';
import cron from 'node-cron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { SeedCatalogReconciler, type CatalogEntry } from './Reconciler.js';

async function readCatalog(): Promise<CatalogEntry[]> {
  const dir = path.join(
    __dirname, '..', '..', '..',
    'packages', 'core-engine', 'src', 'seed', 'seed-memories',
  );
  // F.7 review: prior code returned [] on readdir failure (EIO, EACCES,
  // transient volume unmount). Reconciler.runBatch then treated every
  // install_log row as 'no longer in catalog' and tombstoned it (see
  // Reconciler.ts:192 / :278). A single disk blip = mass install
  // retirement. Re-throw so the cron tick fails loud and a sibling
  // worker (or the next tick) re-runs against a working filesystem.
  const files = await fs.readdir(dir);
  const entries: CatalogEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, f), 'utf-8');
    const parsed = JSON.parse(raw) as { entries?: Array<{
      seedId: string; catalogVersion: string;
      kind: string; summary: string; body?: string;
      importance: number; tags: readonly string[];
    }> };
    if (!Array.isArray(parsed.entries)) continue;
    for (const e of parsed.entries) {
      const importance = Math.min(0.6, Math.max(0, e.importance));
      const nonMarkerTags = [...e.tags].filter((t) => !t.startsWith('seed:'));
      const canonical = JSON.stringify({
        kind: e.kind,
        summary: e.summary,
        body: e.body ?? null,
        importance,
        tags: nonMarkerTags.sort(),
      });
      const contentHash = createHash('sha256').update(canonical).digest('hex');
      entries.push({
        seedId: e.seedId,
        catalogVersion: e.catalogVersion,
        contentHash,
        preview: e as unknown as Record<string, unknown>,
      });
    }
  }
  return entries;
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (!DATABASE_URL) {
    console.error('[seed-catalog-reconciler] DATABASE_URL required');
    process.exit(1);
  }
  const CRON_EXPR = process.env['SEED_CATALOG_RECONCILE_CRON'] ?? '0 4 * * *';
  const autoInstall = process.env['SEED_CATALOG_AUTO_INSTALL_ADDITIVE'] === 'true';
  const enabled = process.env['SEED_CATALOG_VERSIONING_ENABLED'] !== 'false';

  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const reconciler = new SeedCatalogReconciler(pool, readCatalog, {
    autoInstallAdditive: autoInstall,
    isAllowed: async () => enabled,
  });

  void reconciler.runOnce().catch((err) =>
    console.error('[seed-catalog-reconciler] initial run failed', err),
  );

  cron.schedule(CRON_EXPR, () => {
    void reconciler.runOnce().catch((err) =>
      console.error('[seed-catalog-reconciler] scheduled run failed', err),
    );
  });

  console.log(`[seed-catalog-reconciler] scheduled '${CRON_EXPR}' (autoInstallAdditive=${autoInstall}, enabled=${enabled})`);

  const shutdown = async (): Promise<void> => {
    console.log('[seed-catalog-reconciler] shutting down');
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main().catch((err) => {
  console.error('[seed-catalog-reconciler] fatal', err);
  process.exit(1);
});
