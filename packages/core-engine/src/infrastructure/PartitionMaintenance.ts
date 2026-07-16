/**
 * PartitionMaintenance — the monthly-partition maintenance job promised
 * by migration 000041 and installed by 000063.
 *
 * All DDL lives in the SECURITY DEFINER function
 * `oweibo.ensure_month_partitions(months_ahead)` (the app role cannot own
 * partitioned parents); this class is the thin runtime driver: call the
 * function, log the report, count outcomes. It is scheduled daily from
 * main.ts under runWithAdvisoryLock — creation is idempotent, the lock
 * only stops replicas from racing the same tick.
 *
 * The 000062 DEFAULT partitions remain the safety net: if this job never
 * runs, writes still land (in the default); when it runs ahead of
 * rollover — the point of the daily cadence — months get dedicated
 * partitions and the default stays empty. A month whose rows already
 * reached the default reports `skipped_default_rows` (retroactive
 * repartitioning is a manual row-move, deliberately not automated here).
 */
import type { Pool } from 'pg';

export interface PartitionOutcomeRow {
  readonly parent_table: string;
  readonly partition_name: string;
  readonly outcome: 'created' | 'exists' | 'skipped_default_rows' | 'skipped_lock_timeout';
}

export interface PartitionMaintenanceReport {
  readonly rows: readonly PartitionOutcomeRow[];
  readonly created: number;
  readonly skippedDefaultRows: number;
  /** Couldn't get the DDL lock within the function's lock_timeout —
   *  transient under write pressure; the next tick retries. */
  readonly skippedLockTimeout: number;
}

export interface PartitionMaintenanceOptions {
  /** Months ahead of the current one to ensure. Default 2. */
  readonly monthsAhead?: number;
  readonly log?: (level: 'info' | 'warn', line: string, ctx?: unknown) => void;
}

export class PartitionMaintenance {
  private readonly pool: Pool;
  private readonly monthsAhead: number;
  private readonly log: NonNullable<PartitionMaintenanceOptions['log']>;

  constructor(pool: Pool, opts: PartitionMaintenanceOptions = {}) {
    this.pool = pool;
    this.monthsAhead = opts.monthsAhead ?? 2;
    this.log = opts.log ?? defaultLog;
  }

  async tick(): Promise<PartitionMaintenanceReport> {
    const r = await this.pool.query<PartitionOutcomeRow>(
      `SELECT parent_table, partition_name, outcome
         FROM oweibo.ensure_month_partitions($1::int)`,
      [this.monthsAhead],
    );
    const created = r.rows.filter((x) => x.outcome === 'created');
    const skipped = r.rows.filter((x) => x.outcome === 'skipped_default_rows');
    const lockTimeouts = r.rows.filter((x) => x.outcome === 'skipped_lock_timeout');

    for (const row of created) {
      this.log('info', `created partition ${row.partition_name} of ${row.parent_table}`);
    }
    for (const row of skipped) {
      // Rows for that month live in the DEFAULT partition; queries still
      // work (just unpruned for that month). Surfaced every tick on
      // purpose — it only stops once the month is manually moved or ages
      // out of the ensure window.
      this.log('warn',
        `partition ${row.partition_name} not created: rows for that month already sit in ` +
        `${row.parent_table}_default (manual row-move required to repartition)`);
    }
    for (const row of lockTimeouts) {
      this.log('warn',
        `partition ${row.partition_name} not created: DDL lock unavailable within lock_timeout ` +
        `(write pressure on ${row.parent_table}) — will retry next tick`);
    }

    return {
      rows: r.rows,
      created: created.length,
      skippedDefaultRows: skipped.length,
      skippedLockTimeout: lockTimeouts.length,
    };
  }
}

function defaultLog(level: 'info' | 'warn', line: string, ctx?: unknown): void {
  const tag = `[PartitionMaintenance] ${line}`;
  if (level === 'warn') console.warn(tag, ctx ?? '');
  else console.log(tag, ctx ?? '');
}
