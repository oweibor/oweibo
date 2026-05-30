#!/usr/bin/env tsx
/**
 * check-bootstrap-tables.ts (F.5.0)
 *
 * Preflight gate for the F.5 adapter PRs. Connects to DATABASE_URL and
 * verifies that the tables / columns F.5.0's migration adds actually
 * exist with the expected shape. Exits non-zero on any drift so the
 * adapter PRs (F.5.1-F.5.10) cannot land against a DB that hasn't
 * applied the migration.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/check-bootstrap-tables.ts
 */
import { Client } from 'pg';

interface TableSpec {
  schema: string;
  name: string;
  /** Required columns. Checked by information_schema.columns. */
  columns: readonly string[];
}

interface ColumnAddSpec {
  schema: string;
  table: string;
  column: string;
  dataType: string;
}

const REQUIRED_TABLES: readonly TableSpec[] = [
  {
    schema: 'oweibo',
    name: 'tenant_goal_templates_ack',
    columns: ['tenant_id', 'slug', 'catalog_version', 'source', 'acknowledged_at'],
  },
  {
    schema: 'oweibo',
    name: 'tenant_bandit_arms',
    columns: ['tenant_id', 'arm_id', 'slot_id', 'channel', 'alpha', 'beta', 'source'],
  },
  {
    schema: 'oweibo',
    name: 'tenant_projects',
    columns: ['id', 'tenant_id', 'template_slug', 'name', 'spec', 'state', 'created_at'],
  },
];

const REQUIRED_COLUMN_ADDS: readonly ColumnAddSpec[] = [
  {
    schema: 'oweibo',
    table:  'action_proposals',
    column: 'created_by_scopes',
    dataType: 'ARRAY',
  },
];

interface CheckSpec {
  schema: string;
  table: string;
  constraint: string;
  expectedValuesContain: readonly string[];
}

const REQUIRED_CHECK_CONSTRAINTS: readonly CheckSpec[] = [
  {
    schema: 'oweibo',
    table:  'tenant_connectors',
    constraint: 'tenant_connectors_status_check',
    expectedValuesContain: ['recommended'],
  },
];

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL required');
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  let problems = 0;
  try {
    // ── Tables ────────────────────────────────────────────────────────────
    for (const t of REQUIRED_TABLES) {
      const present = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2`,
        [t.schema, t.name],
      );
      if (present.rows.length === 0) {
        console.error(`✗ table missing: ${t.schema}.${t.name}`);
        problems++;
        continue;
      }
      const have = new Set(present.rows.map((r) => r.column_name));
      const missing = t.columns.filter((c) => !have.has(c));
      if (missing.length > 0) {
        console.error(`✗ ${t.schema}.${t.name} missing columns: ${missing.join(', ')}`);
        problems++;
      } else {
        console.log(`✓ ${t.schema}.${t.name} (${t.columns.length} required columns present)`);
      }
    }

    // ── ALTER-added columns ───────────────────────────────────────────────
    for (const c of REQUIRED_COLUMN_ADDS) {
      const r = await client.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [c.schema, c.table, c.column],
      );
      if (r.rows.length === 0) {
        console.error(`✗ column missing: ${c.schema}.${c.table}.${c.column}`);
        problems++;
      } else if (r.rows[0]!.data_type !== c.dataType) {
        console.error(`✗ ${c.schema}.${c.table}.${c.column} has data_type=${r.rows[0]!.data_type}, expected ${c.dataType}`);
        problems++;
      } else {
        console.log(`✓ ${c.schema}.${c.table}.${c.column} (${c.dataType})`);
      }
    }

    // ── CHECK constraints whose enumerated values must contain a literal ─
    for (const ck of REQUIRED_CHECK_CONSTRAINTS) {
      const r = await client.query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(oid)
           FROM pg_constraint
          WHERE conname = $1
            AND conrelid = ($2 || '.' || $3)::regclass`,
        [ck.constraint, ck.schema, ck.table],
      );
      if (r.rows.length === 0) {
        console.error(`✗ constraint missing: ${ck.constraint} on ${ck.schema}.${ck.table}`);
        problems++;
        continue;
      }
      const def = r.rows[0]!.pg_get_constraintdef;
      const missingVals = ck.expectedValuesContain.filter((v) => !def.includes(`'${v}'`));
      if (missingVals.length > 0) {
        console.error(`✗ ${ck.constraint} missing values: ${missingVals.join(', ')} (current def: ${def})`);
        problems++;
      } else {
        console.log(`✓ ${ck.constraint} contains: ${ck.expectedValuesContain.join(', ')}`);
      }
    }
  } finally {
    await client.end();
  }

  if (problems > 0) {
    console.error(`\n✗ ${problems} preflight check(s) failed. Run the F.5.0 migration before merging adapter PRs.`);
    process.exit(1);
  }
  console.log('\n✓ F.5.0 bootstrap preflight: all checks passed.');
}

main().catch((err: unknown) => {
  console.error('check-bootstrap-tables fatal:', err);
  process.exit(2);
});
