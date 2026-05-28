/**
 * D.7 (domain-depth): DomainCurrencyMonitor — daily cron that ages
 * domain artifacts and pulls regulatory feeds.
 *
 * Each `tick()` walks the `domain_artifact_currency` table and
 * transitions states based on `valid_until` vs `now()`:
 *
 *     current        → expiring_soon  (valid_until - now <= expiringSoonThreshold)
 *     expiring_soon  → expired        (valid_until <= now)
 *     current        → expired        (only when expiringSoonThreshold==0)
 *
 * Then for every artifact with `refresh_policy='feed_driven'`, the
 * monitor invokes the registered feed adapter (if any), honoring the
 * hot-loop guard (skip when `last_successful_at` within
 * `refreshInterval / 4`). Each `RegulatoryUpdate` is inserted into
 * `regulatory_feed_items` with state='pending' — the SME loop (D.5)
 * picks them up.
 *
 * Failures are isolated: a feed adapter throwing does not stop other
 * feeds from running; the failure is recorded in `domain_feed_health`
 * with the error message and a consecutive_failures counter.
 *
 * The monitor never deletes data — supersession is trigger-driven at
 * the DB layer when a newer artifact_id is inserted.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  DomainArtifactCurrency,
  DomainArtifactState,
  DomainFeedHealth,
  IRegulatoryFeed,
  RegulatoryUpdate,
} from '@oweibo/core-contracts';

const DAY_SECONDS = 86_400;
const DEFAULT_EXPIRING_SOON_SECONDS = 30 * DAY_SECONDS;

export interface DomainCurrencyMonitorOptions {
  /** Default 30 days. Set to 0 to disable the expiring_soon transition. */
  expiringSoonThresholdSeconds?: number;
  /** Default 'platform_admin'. */
  setLocalRole?: () => string;
  now?: () => Date;
  /** Console-by-default; tests inject a recording sink. */
  log?: (level: 'info' | 'warn' | 'error', line: string, ctx?: unknown) => void;
}

export interface TickResult {
  readonly artifactsScanned: number;
  readonly transitions: readonly ArtifactTransition[];
  readonly feedsAttempted: number;
  readonly feedItemsInserted: number;
  readonly feedFailures: readonly { feedId: string; error: string }[];
}

export interface ArtifactTransition {
  readonly artifactKind: DomainArtifactCurrency['artifactKind'];
  readonly artifactId: string;
  readonly from: DomainArtifactState;
  readonly to: DomainArtifactState;
}

export class DomainCurrencyMonitor {
  private readonly expiringSoon: number;
  private readonly roleName: () => string;
  private readonly now: () => Date;
  private readonly log: NonNullable<DomainCurrencyMonitorOptions['log']>;
  private readonly feeds = new Map<string, IRegulatoryFeed>();

  constructor(private readonly pool: Pool, opts: DomainCurrencyMonitorOptions = {}) {
    this.expiringSoon = opts.expiringSoonThresholdSeconds ?? DEFAULT_EXPIRING_SOON_SECONDS;
    this.roleName = opts.setLocalRole ?? (() => 'platform_admin');
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? defaultLog;
  }

  /** Register a feed adapter. Idempotent on identical feedId. */
  registerFeed(feed: IRegulatoryFeed): void {
    this.feeds.set(feed.feedId, feed);
  }

  /** All currently registered feed adapters (test introspection). */
  registeredFeeds(): readonly string[] {
    return [...this.feeds.keys()].sort();
  }

  async tick(): Promise<TickResult> {
    const transitions: ArtifactTransition[] = [];
    const feedFailures: { feedId: string; error: string }[] = [];
    let artifactsScanned = 0;
    let feedsAttempted = 0;
    let feedItemsInserted = 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);

      // State transitions.
      const artifacts = await client.query<ArtifactRow>(
        `SELECT artifact_kind, artifact_id, domain_slug, valid_from, valid_until,
                refresh_policy, refresh_interval, feed_refs, state, superseded_by,
                last_state_transition
           FROM oweibo.domain_artifact_currency
          WHERE state IN ('current','expiring_soon')`,
      );
      artifactsScanned = artifacts.rows.length;
      const nowDate = this.now();
      const nowMs = nowDate.getTime();
      for (const row of artifacts.rows) {
        const until = new Date(row.valid_until).getTime();
        let next: DomainArtifactState | null = null;
        if (until <= nowMs) next = 'expired';
        else if (this.expiringSoon > 0 && until - nowMs <= this.expiringSoon * 1000) next = 'expiring_soon';
        if (next && next !== row.state) {
          await client.query(
            `UPDATE oweibo.domain_artifact_currency
                SET state = $3, last_state_transition = $4
              WHERE artifact_kind = $1 AND artifact_id = $2`,
            [row.artifact_kind, row.artifact_id, next, nowDate],
          );
          transitions.push({
            artifactKind: row.artifact_kind,
            artifactId: row.artifact_id,
            from: row.state,
            to: next,
          });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Feed invocations (separate transactions per feed — a failure must
    // not roll back another feed's inserts).
    for (const feed of this.feeds.values()) {
      feedsAttempted++;
      try {
        const inserted = await this.runFeed(feed);
        feedItemsInserted += inserted;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        feedFailures.push({ feedId: feed.feedId, error: msg });
        this.log('warn', `feed ${feed.feedId} failed`, { error: msg });
      }
    }

    return {
      artifactsScanned,
      transitions,
      feedsAttempted,
      feedItemsInserted,
      feedFailures,
    };
  }

  /**
   * Public for tests; the cron path always goes through tick(). Returns
   * the number of `regulatory_feed_items` rows inserted (excluding
   * UNIQUE-conflict duplicates).
   */
  async runFeed(feed: IRegulatoryFeed): Promise<number> {
    // Hot-loop guard: read health, skip if last success is recent.
    const health = await this.loadHealth(feed.feedId);
    const refreshInterval = await this.loadFeedRefreshInterval(feed.feedId);
    if (health?.lastSuccessfulAt && refreshInterval && refreshInterval > 0) {
      const lastMs = new Date(health.lastSuccessfulAt).getTime();
      const elapsedSec = (this.now().getTime() - lastMs) / 1000;
      if (elapsedSec < refreshInterval / 4) {
        this.log('info', `skipping feed ${feed.feedId} (within refreshInterval/4 of last success)`);
        return 0;
      }
    }

    const since = health?.lastSuccessfulAt ? new Date(health.lastSuccessfulAt) : new Date(0);
    let updates: readonly RegulatoryUpdate[];
    try {
      updates = await feed.fetchUpdates(since);
    } catch (err) {
      await this.recordHealth(feed.feedId, { success: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    const inserted = await this.insertFeedItems(feed, updates);
    await this.recordHealth(feed.feedId, { success: true });
    return inserted;
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async insertFeedItems(
    feed: IRegulatoryFeed,
    updates: readonly RegulatoryUpdate[],
  ): Promise<number> {
    if (updates.length === 0) return 0;
    let inserted = 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      for (const u of updates) {
        const r = await client.query(
          `INSERT INTO oweibo.regulatory_feed_items
             (feed_id, update_id, domain_slug, published_at, title, summary,
              source_url, impact_area, suggested_targets)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (feed_id, update_id) DO NOTHING`,
          [
            feed.feedId,
            u.updateId,
            feed.domainSlug,
            u.publishedAt,
            u.title,
            u.summary,
            u.sourceUrl,
            u.impactArea,
            u.suggestedTargets,
          ],
        );
        if ((r.rowCount ?? 0) > 0) inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return inserted;
  }

  private async loadHealth(feedId: string): Promise<DomainFeedHealth | null> {
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<HealthRow>(
        `SELECT feed_id, last_attempted_at, last_successful_at, last_error, consecutive_failures
           FROM oweibo.domain_feed_health WHERE feed_id = $1`,
        [feedId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        feedId: row.feed_id,
        lastAttemptedAt: row.last_attempted_at ? toIso(row.last_attempted_at) : null,
        lastSuccessfulAt: row.last_successful_at ? toIso(row.last_successful_at) : null,
        lastError: row.last_error,
        consecutiveFailures: row.consecutive_failures,
      };
    } finally {
      client.release();
    }
  }

  /**
   * The refresh interval for a feed is the MIN across artifacts that
   * reference it. v1 takes the simplest path: look up any artifact with
   * feed_ref containing the feed_id and return its refresh_interval
   * seconds. NULL when no artifact references the feed (feed runs
   * every tick).
   */
  private async loadFeedRefreshInterval(feedId: string): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      await this.setAdminScope(client);
      const r = await client.query<{ refresh_seconds: string | null }>(
        `SELECT MIN(EXTRACT(EPOCH FROM refresh_interval))::text AS refresh_seconds
           FROM oweibo.domain_artifact_currency
          WHERE $1 = ANY(feed_refs) AND refresh_interval IS NOT NULL`,
        [feedId],
      );
      const v = r.rows[0]?.refresh_seconds;
      if (!v) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } finally {
      client.release();
    }
  }

  private async recordHealth(
    feedId: string,
    outcome: { success: boolean; error?: string },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.setAdminScope(client);
      const now = this.now();
      if (outcome.success) {
        await client.query(
          `INSERT INTO oweibo.domain_feed_health
             (feed_id, last_attempted_at, last_successful_at, last_error, consecutive_failures)
           VALUES ($1, $2, $2, NULL, 0)
           ON CONFLICT (feed_id) DO UPDATE
             SET last_attempted_at    = EXCLUDED.last_attempted_at,
                 last_successful_at   = EXCLUDED.last_successful_at,
                 last_error           = NULL,
                 consecutive_failures = 0`,
          [feedId, now],
        );
      } else {
        await client.query(
          `INSERT INTO oweibo.domain_feed_health
             (feed_id, last_attempted_at, last_error, consecutive_failures)
           VALUES ($1, $2, $3, 1)
           ON CONFLICT (feed_id) DO UPDATE
             SET last_attempted_at    = EXCLUDED.last_attempted_at,
                 last_error           = EXCLUDED.last_error,
                 consecutive_failures = oweibo.domain_feed_health.consecutive_failures + 1`,
          [feedId, now, outcome.error ?? 'unknown'],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async setAdminScope(client: PoolClient): Promise<void> {
    await client.query(`SET LOCAL ROLE ${this.roleName()}`).catch(() => undefined);
    await client.query(`SET LOCAL app.is_platform_admin = 'true'`).catch(() => undefined);
  }
}

interface ArtifactRow {
  artifact_kind: DomainArtifactCurrency['artifactKind'];
  artifact_id: string;
  domain_slug: string | null;
  valid_from: Date | string;
  valid_until: Date | string;
  refresh_policy: DomainArtifactCurrency['refreshPolicy'];
  refresh_interval: string | null;
  feed_refs: string[];
  state: DomainArtifactState;
  superseded_by: string | null;
  last_state_transition: Date | string;
}

interface HealthRow {
  feed_id: string;
  last_attempted_at: Date | string | null;
  last_successful_at: Date | string | null;
  last_error: string | null;
  consecutive_failures: number;
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

function defaultLog(level: 'info' | 'warn' | 'error', line: string, _ctx?: unknown): void {
  if (level === 'error') console.error(`[DomainCurrencyMonitor] ${line}`);
  else if (level === 'warn') console.warn(`[DomainCurrencyMonitor] ${line}`);
  else console.log(`[DomainCurrencyMonitor] ${line}`);
}
