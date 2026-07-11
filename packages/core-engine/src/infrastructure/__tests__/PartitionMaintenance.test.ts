/**
 * PartitionMaintenance unit tests — the driver's contract with the
 * 000063 SQL function (parameter passed through, outcomes counted,
 * skipped months surfaced as warnings). The function's own behavior is
 * covered live by packages/db's partition-maintenance vitest suite.
 */
import { PartitionMaintenance } from '../PartitionMaintenance.js';
import type { Pool } from 'pg';

function stubPool(rows: Array<{ parent_table: string; partition_name: string; outcome: string }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('PartitionMaintenance', () => {
  it('calls ensure_month_partitions with the configured horizon and counts outcomes', async () => {
    const { pool, calls } = stubPool([
      { parent_table: 'audit_log', partition_name: 'audit_log_2026_07', outcome: 'skipped_default_rows' },
      { parent_table: 'audit_log', partition_name: 'audit_log_2026_08', outcome: 'created' },
      { parent_table: 'audit_log', partition_name: 'audit_log_2026_09', outcome: 'exists' },
      { parent_table: 'action_lineage', partition_name: 'action_lineage_y2026m08', outcome: 'created' },
    ]);
    const logs: Array<{ level: string; line: string }> = [];
    const pm = new PartitionMaintenance(pool, {
      monthsAhead: 3,
      log: (level, line) => logs.push({ level, line }),
    });

    const report = await pm.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/oweibo\.ensure_month_partitions\(\$1::int\)/);
    expect(calls[0]!.values).toEqual([3]);
    expect(report.created).toBe(2);
    expect(report.skippedDefaultRows).toBe(1);
    expect(report.rows).toHaveLength(4);

    expect(logs.filter((l) => l.level === 'info')).toHaveLength(2);
    const warns = logs.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.line).toMatch(/audit_log_2026_07.*audit_log_default/);
  });

  it('defaults to 2 months ahead and stays quiet when everything exists', async () => {
    const { pool, calls } = stubPool([
      { parent_table: 'audit_log', partition_name: 'audit_log_2026_07', outcome: 'exists' },
      { parent_table: 'action_lineage', partition_name: 'action_lineage_y2026m07', outcome: 'exists' },
    ]);
    const logs: string[] = [];
    const pm = new PartitionMaintenance(pool, { log: (_l, line) => logs.push(line) });

    const report = await pm.tick();

    expect(calls[0]!.values).toEqual([2]);
    expect(report.created).toBe(0);
    expect(report.skippedDefaultRows).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it('propagates query failures to the caller (the cron tick logs them)', async () => {
    const pool = {
      query: async () => {
        throw new Error('function oweibo.ensure_month_partitions(integer) does not exist');
      },
    } as unknown as Pool;
    await expect(new PartitionMaintenance(pool).tick()).rejects.toThrow(/does not exist/);
  });
});
