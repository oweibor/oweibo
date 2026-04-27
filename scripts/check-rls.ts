#!/usr/bin/env tsx
/**
 * check-rls.ts
 *
 * Pre-commit / CI gate: verifies that every Prisma model in packages/db that
 * declares a `tenantId` field also has an RLS migration referencing it.
 *
 * Exits 1 if any model with tenantId is missing an RLS migration.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH     = path.join(ROOT, 'packages/db/prisma/schema.prisma');
const MIGRATIONS_DIR  = path.join(ROOT, 'packages/db/migrations');

function parseModelsWithTenantId(schema: string): string[] {
  const models: string[] = [];
  const modelBlocks = schema.matchAll(/^model\s+(\w+)\s*\{([^}]+)\}/gm);
  for (const match of modelBlocks) {
    const name   = match[1]!;
    const body   = match[2]!;
    if (/\btenantId\b|\btenant_id\b/.test(body)) {
      models.push(name);
    }
  }
  return models;
}

function migrationsMentioning(model: string, migrations: string[]): string[] {
  // A migration that sets up RLS for a model must contain both
  // the table reference and the RLS keyword for that table.
  const tablePattern = new RegExp(
    `(?:ENABLE ROW LEVEL SECURITY|CREATE POLICY).*${model.toLowerCase()}|` +
    `${model.toLowerCase()}.*(?:ENABLE ROW LEVEL SECURITY|CREATE POLICY)`,
    'i'
  );
  return migrations.filter(m => tablePattern.test(m));
}

function main() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`Schema not found: ${SCHEMA_PATH}`);
    process.exit(1);
  }

  const schema     = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const tenantModels = parseModelsWithTenantId(schema);

  if (tenantModels.length === 0) {
    console.log('✓ No models with tenantId found — RLS check skipped.');
    process.exit(0);
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`✗ Migrations directory not found: ${MIGRATIONS_DIR}`);
    console.error(`  Models requiring RLS: ${tenantModels.join(', ')}`);
    process.exit(1);
  }

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));

  const allMigrationText = migrationFiles.join('\n');

  const missing: string[] = [];
  for (const model of tenantModels) {
    // Use the @map name for Postgres table (snake_case from Prisma convention)
    const tableName = model
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      .replace(/^_/, '');

    const hasRls = new RegExp(
      `ENABLE ROW LEVEL SECURITY[^;]*${tableName}|` +
      `${tableName}[^;]*ENABLE ROW LEVEL SECURITY|` +
      `CREATE POLICY\\s+\\w+\\s+ON\\s+\\w+\\.${tableName}`,
      'i'
    ).test(allMigrationText);

    if (!hasRls) {
      missing.push(model);
    }
  }

  if (missing.length > 0) {
    console.error('✗ RLS migrations missing for the following models:');
    missing.forEach(m => console.error(`  - ${m}`));
    console.error('\nEvery oweibo.* model with tenantId must have a migration that calls');
    console.error('ALTER TABLE ... ENABLE ROW LEVEL SECURITY and CREATE POLICY tenant_isolation.');
    process.exit(1);
  }

  console.log(`✓ RLS migrations verified for ${tenantModels.length} tenant-scoped model(s): ${tenantModels.join(', ')}`);
  process.exit(0);
}

main();

