/**
 * Live coverage for migration 000063's oweibo.ensure_month_partitions()
 * — the monthly-partition maintenance function 000041 promised.
 *
 * Runs as oweibo_app (the function is SECURITY DEFINER; EXECUTE is the
 * only privilege the app role has or needs — it cannot create partitions
 * itself). Skips without TEST_DATABASE_URL, per suite convention.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
const describeOrSkip = TEST_DB_URL ? describe : describe.skip;

interface OutcomeRow {
  parent_table: string;
  partition_name: string;
  outcome: 'created' | 'exists' | 'skipped_default_rows' | 'skipped_lock_timeout';
}

describeOrSkip('ensure_month_partitions (000063)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('ensures current + N months for both partitioned tables, idempotently', async () => {
    const first = await pool.query<OutcomeRow>(
      `SELECT * FROM oweibo.ensure_month_partitions(2)`,
    );
    // 2 tables × (current + 2) months.
    expect(first.rows).toHaveLength(6);
    expect(new Set(first.rows.map((r) => r.parent_table))).toEqual(
      new Set(['audit_log', 'action_lineage']),
    );
    for (const row of first.rows) {
      expect(['created', 'exists', 'skipped_default_rows']).toContain(row.outcome);
    }

    // Every ensured month resolves to a real relation (skipped months
    // have no dedicated partition by design — their rows are in default).
    for (const row of first.rows.filter((r) => r.outcome !== 'skipped_default_rows')) {
      const reg = await pool.query<{ ok: string | null }>(
        `SELECT to_regclass('oweibo.' || quote_ident($1))::text AS ok`,
        [row.partition_name],
      );
      expect(reg.rows[0]!.ok).not.toBeNull();
    }

    // Second run: nothing newly created — pure idempotence.
    const second = await pool.query<OutcomeRow>(
      `SELECT * FROM oweibo.ensure_month_partitions(2)`,
    );
    expect(second.rows.filter((r) => r.outcome === 'created')).toHaveLength(0);
  });

  it('new action_lineage partitions inherit the 000063 parent indexes', async () => {
    const rows = await pool.query<OutcomeRow>(
      `SELECT * FROM oweibo.ensure_month_partitions(2)`,
    );
    const lineagePartition = rows.rows
      .filter((r) => r.parent_table === 'action_lineage' && r.outcome !== 'skipped_default_rows')
      .map((r) => r.partition_name)
      .pop();
    expect(lineagePartition).toBeDefined();

    const idx = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'oweibo' AND tablename = $1`,
      [lineagePartition],
    );
    const defs = idx.rows.map((r) => r.indexdef).join('\n');
    expect(defs).toMatch(/\(tenant_id, recorded_at\)/);
    expect(defs).toMatch(/\(plan_id, recorded_at\)/);
    expect(defs).toMatch(/\(parent_node_id\)/);
  });

  it('rejects an out-of-range horizon', async () => {
    await expect(pool.query(`SELECT * FROM oweibo.ensure_month_partitions(25)`))
      .rejects.toThrow(/must be in \[0, 24\]/);
    await expect(pool.query(`SELECT * FROM oweibo.ensure_month_partitions(-1)`))
      .rejects.toThrow(/must be in \[0, 24\]/);
  });

  it('rejects a NULL horizon with a clear error, not a loop-bound crash (000064)', async () => {
    await expect(pool.query(`SELECT * FROM oweibo.ensure_month_partitions(NULL::int)`))
      .rejects.toThrow(/must be in \[0, 24\], got NULL/);
  });

  it('concurrent callers both succeed — a lost create race reports exists, never errors (000064)', async () => {
    // Two sessions race the same horizon. Pre-000064, the loser of a
    // create race died on an uncaught duplicate_table error. With every
    // window month already ensured this mostly exercises the read path,
    // but a month rollover between suite runs makes it a genuine race —
    // either way both calls MUST resolve.
    const [a, b] = await Promise.all([
      pool.query<OutcomeRow>(`SELECT * FROM oweibo.ensure_month_partitions(3)`),
      pool.query<OutcomeRow>(`SELECT * FROM oweibo.ensure_month_partitions(3)`),
    ]);
    expect(a.rows).toHaveLength(8);
    expect(b.rows).toHaveLength(8);
    for (const row of [...a.rows, ...b.rows]) {
      expect(['created', 'exists', 'skipped_default_rows', 'skipped_lock_timeout']).toContain(row.outcome);
    }
  });
});
