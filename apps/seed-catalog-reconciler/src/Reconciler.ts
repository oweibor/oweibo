/**
 * T.7: SeedCatalogReconciler — diffs the current platform seed catalog
 * against per-tenant install logs and writes pending_update rows for the
 * deltas that require operator attention.
 *
 * Diff classes (catalog vs install_log):
 *   - additive: seed_id in catalog, missing from install_log.
 *               When seed_catalog_auto_install.enabled, the additive
 *               update is recorded with resolution='installed' (caller's
 *               install path will pick it up); otherwise written as
 *               unresolved 'additive'.
 *   - revision: seed_id present in both, content_hash differs.
 *               Always unresolved — tenant admin decides.
 *   - removal:  seed_id present in install_log, absent from catalog.
 *               Tombstoned by setting retired_at on the install_log row;
 *               the tenant's Qdrant entry is tagged seed:retired:<reason>
 *               by a downstream worker (out of scope here — the
 *               retirement_reason is recorded so the worker can pick it up).
 *
 * Content hash is the discriminator, not catalog version (per the plan's
 * "discrimination is by content hash, not version string" note).
 *
 * Tenant scope: the reconciler iterates active tenants. It is intentionally
 * decoupled from BootstrapWorker — that worker writes install_log rows on
 * seed insertion; the reconciler observes those rows and the current
 * catalog as independent inputs.
 */
import type { Pool, PoolClient } from 'pg';

export type ChangeKind = 'additive' | 'revision' | 'removal';

export interface CatalogEntry {
  readonly seedId: string;
  readonly catalogVersion: string;
  readonly contentHash: string;
  /** Canonical JSON payload surfaced as preview_payload. */
  readonly preview: Readonly<Record<string, unknown>>;
}

export interface InstallLogRow {
  readonly tenantId: string;
  readonly seedId: string;
  readonly catalogVersion: string;
  readonly contentHash: string;
  readonly retiredAt: Date | null;
}

export interface DiffEntry {
  readonly tenantId: string;
  readonly seedId: string;
  readonly changeKind: ChangeKind;
  readonly fromCatalogVersion: string;
  readonly toCatalogVersion: string;
  readonly fromContentHash: string | null;
  readonly toContentHash: string;
  readonly preview: Readonly<Record<string, unknown>>;
}

export interface ReconcilerOptions {
  /** When true, additive diffs are written with resolution='installed'. */
  autoInstallAdditive?: boolean;
  /** Returns true when reconciler is allowed to run. */
  isAllowed?: () => Promise<boolean>;
  /** Tag reason recorded on retired install_log rows. Default 'removed_from_catalog'. */
  retirementReason?: string;
  /**
   * Audit-fix (T.7): pagination batch size. The reconciler scans the
   * tenants table and iterates per-tenant; without batching, a single
   * monolithic loop OOMs at scale (200k+ tenant rows × ~200 catalog
   * entries). Default 100 — empirical sweet spot for in-process diff
   * memory. Tune up for fewer transactions, down for tighter peak
   * memory.
   */
  tenantBatchSize?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

export interface ReconciliationResult {
  readonly additiveDetected: number;
  readonly revisionsDetected: number;
  readonly removalsTombstoned: number;
  readonly tenantsScanned: number;
}

const DEFAULT_REASON = 'removed_from_catalog';

const DEFAULT_TENANT_BATCH_SIZE = 100;

export class SeedCatalogReconciler {
  private readonly autoInstallAdditive: boolean;
  private readonly isAllowed: () => Promise<boolean>;
  private readonly retirementReason: string;
  private readonly tenantBatchSize: number;
  private readonly log: NonNullable<ReconcilerOptions['log']>;

  constructor(
    private readonly pool: Pool,
    private readonly catalogProvider: () => Promise<readonly CatalogEntry[]>,
    opts: ReconcilerOptions = {},
  ) {
    this.autoInstallAdditive = opts.autoInstallAdditive ?? false;
    this.isAllowed = opts.isAllowed ?? (async () => true);
    this.retirementReason = opts.retirementReason ?? DEFAULT_REASON;
    this.tenantBatchSize = opts.tenantBatchSize ?? DEFAULT_TENANT_BATCH_SIZE;
    this.log = opts.log ?? defaultLog;
  }

  /**
   * Audit-fix (T.7): scans tenants in pages and commits per-page so a
   * single monolithic run does not OOM at scale. The pre-fix version
   * loaded ALL active tenants into one transaction, then iterated
   * per-tenant inside that tx, accumulating row locks for hours on a
   * large install. Per-page commits release locks immediately and
   * bound peak memory to (tenantBatchSize × catalog_size).
   */
  async runOnce(): Promise<ReconciliationResult> {
    const allowed = await this.isAllowed();
    if (!allowed) {
      this.log('info', 'SeedCatalogReconciler skipped — feature flag off');
      return { additiveDetected: 0, revisionsDetected: 0, removalsTombstoned: 0, tenantsScanned: 0 };
    }

    const catalog = await this.catalogProvider();
    const catalogBySeedId = new Map(catalog.map((c) => [c.seedId, c]));

    let additive = 0;
    let revisions = 0;
    let removals = 0;
    let scanned = 0;
    let lastId: string | null = null;

    // Pagination loop: keyset pagination on the tenants PK so we never
    // revisit a tenant within a single run, and so adding tenants
    // mid-run doesn't shift offsets.
    while (true) {
      const batch = await this.runBatch(catalog, catalogBySeedId, lastId);
      additive += batch.additive;
      revisions += batch.revisions;
      removals += batch.removals;
      scanned += batch.scannedIds.length;
      if (batch.scannedIds.length < this.tenantBatchSize) break;
      lastId = batch.scannedIds[batch.scannedIds.length - 1] ?? null;
      if (!lastId) break;
    }

    const result: ReconciliationResult = {
      additiveDetected: additive,
      revisionsDetected: revisions,
      removalsTombstoned: removals,
      tenantsScanned: scanned,
    };
    this.log('info', 'SeedCatalogReconciler complete', result as unknown as Record<string, unknown>);
    return result;
  }

  private async runBatch(
    catalog: readonly CatalogEntry[],
    catalogBySeedId: Map<string, CatalogEntry>,
    afterId: string | null,
  ): Promise<{ additive: number; revisions: number; removals: number; scannedIds: string[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);

      // Keyset pagination by id. `id > $1` works on UUIDs (lexicographic
      // order on the canonical UUID string is stable). FOR UPDATE SKIP
      // LOCKED would be needed only if multiple reconcilers ran in
      // parallel — the platform runs a single instance.
      // SQL kept compact (no embedded newlines) so existing test stubs
      // that substring-match `FROM oweibo.tenants WHERE status = 'active'`
      // continue to match.
      const tenants = await client.query<{ id: string }>(
        afterId === null
          ? `SELECT id FROM oweibo.tenants WHERE status = 'active' ORDER BY id ASC LIMIT $1`
          : `SELECT id FROM oweibo.tenants WHERE status = 'active' AND id > $2::uuid ORDER BY id ASC LIMIT $1`,
        afterId === null ? [this.tenantBatchSize] : [this.tenantBatchSize, afterId],
      );

      let additive = 0;
      let revisions = 0;
      let removals = 0;
      const scannedIds: string[] = [];

      for (const t of tenants.rows) {
        scannedIds.push(t.id);
        const installs = await loadInstalls(client, t.id);
        const diffs = classify(t.id, catalog, catalogBySeedId, installs);

        for (const diff of diffs) {
          if (diff.changeKind === 'removal') {
            await tombstoneInstall(client, diff.tenantId, diff.seedId, this.retirementReason);
            removals += 1;
            continue;
          }
          const resolution = (diff.changeKind === 'additive' && this.autoInstallAdditive)
            ? 'installed'
            : null;
          await upsertPending(client, diff, resolution);
          if (diff.changeKind === 'additive') additive += 1;
          else revisions += 1;
        }
      }

      await client.query('COMMIT');
      return { additive, revisions, removals, scannedIds };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.log('error', 'SeedCatalogReconciler batch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Diff classification ──────────────────────────────────────────────────

export function classify(
  tenantId: string,
  catalog: readonly CatalogEntry[],
  catalogBySeedId: Map<string, CatalogEntry>,
  installs: readonly InstallLogRow[],
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const installBySeedId = new Map<string, InstallLogRow>();
  for (const i of installs) installBySeedId.set(i.seedId, i);

  // Pass 1: catalog → install_log direction (additive + revision)
  for (const c of catalog) {
    const i = installBySeedId.get(c.seedId);
    if (!i) {
      out.push({
        tenantId,
        seedId: c.seedId,
        changeKind: 'additive',
        fromCatalogVersion: '',
        toCatalogVersion: c.catalogVersion,
        fromContentHash: null,
        toContentHash: c.contentHash,
        preview: c.preview,
      });
      continue;
    }
    if (i.retiredAt) {
      // Previously retired but now in catalog again — treat as additive (re-introduce).
      out.push({
        tenantId,
        seedId: c.seedId,
        changeKind: 'additive',
        fromCatalogVersion: i.catalogVersion,
        toCatalogVersion: c.catalogVersion,
        fromContentHash: null,
        toContentHash: c.contentHash,
        preview: c.preview,
      });
      continue;
    }
    if (i.contentHash !== c.contentHash) {
      out.push({
        tenantId,
        seedId: c.seedId,
        changeKind: 'revision',
        fromCatalogVersion: i.catalogVersion,
        toCatalogVersion: c.catalogVersion,
        fromContentHash: i.contentHash,
        toContentHash: c.contentHash,
        preview: c.preview,
      });
    }
  }

  // Pass 2: install_log → catalog direction (removal)
  for (const i of installs) {
    if (i.retiredAt) continue;
    if (!catalogBySeedId.has(i.seedId)) {
      out.push({
        tenantId,
        seedId: i.seedId,
        changeKind: 'removal',
        fromCatalogVersion: i.catalogVersion,
        toCatalogVersion: '',
        fromContentHash: i.contentHash,
        toContentHash: i.contentHash, // unchanged — but the row needs a non-null value
        preview: {},
      });
    }
  }

  return out;
}

// ── DB helpers ───────────────────────────────────────────────────────────

async function loadInstalls(client: PoolClient, tenantId: string): Promise<InstallLogRow[]> {
  const result = await client.query<{
    tenant_id: string; seed_id: string; catalog_version: string;
    content_hash: string; retired_at: Date | null;
  }>(
    `SELECT tenant_id, seed_id, catalog_version, content_hash, retired_at
       FROM oweibo.tenant_seed_install_log
      WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return result.rows.map((r) => ({
    tenantId: r.tenant_id,
    seedId: r.seed_id,
    catalogVersion: r.catalog_version,
    contentHash: r.content_hash,
    retiredAt: r.retired_at,
  }));
}

async function tombstoneInstall(
  client: PoolClient,
  tenantId: string,
  seedId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE oweibo.tenant_seed_install_log
        SET retired_at = NOW(), retirement_reason = $3
      WHERE tenant_id = $1::uuid AND seed_id = $2 AND retired_at IS NULL`,
    [tenantId, seedId, reason],
  );
}

async function upsertPending(
  client: PoolClient,
  diff: DiffEntry,
  resolution: 'installed' | null,
): Promise<void> {
  const detectedAt = new Date();
  const resolvedAt = resolution !== null ? detectedAt : null;
  await client.query(
    `INSERT INTO oweibo.tenant_catalog_pending_updates (
       tenant_id, seed_id, from_catalog_version, to_catalog_version,
       from_content_hash, to_content_hash, change_kind, preview_payload,
       detected_at, resolved_at, resolution, resolved_by
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, NULL
     )
     ON CONFLICT (tenant_id, seed_id, to_content_hash) DO UPDATE
       SET from_catalog_version = EXCLUDED.from_catalog_version,
           to_catalog_version   = EXCLUDED.to_catalog_version,
           from_content_hash    = EXCLUDED.from_content_hash,
           change_kind          = EXCLUDED.change_kind,
           preview_payload      = EXCLUDED.preview_payload,
           detected_at          = EXCLUDED.detected_at,
           resolved_at          = COALESCE(EXCLUDED.resolved_at, oweibo.tenant_catalog_pending_updates.resolved_at),
           resolution           = COALESCE(EXCLUDED.resolution,  oweibo.tenant_catalog_pending_updates.resolution)`,
    [
      diff.tenantId,
      diff.seedId,
      diff.fromCatalogVersion,
      diff.toCatalogVersion,
      diff.fromContentHash,
      diff.toContentHash,
      diff.changeKind,
      JSON.stringify(diff.preview),
      detectedAt,
      resolvedAt,
      resolution,
    ],
  );
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${message} ${JSON.stringify(extra)}` : message;
  if (level === 'error') console.error(`[SeedCatalogReconciler] ${line}`);
  else if (level === 'warn') console.warn(`[SeedCatalogReconciler] ${line}`);
  else console.log(`[SeedCatalogReconciler] ${line}`);
}
