#!/usr/bin/env tsx
/**
 * db-setup.ts — one-shot database bring-up for local/dev.
 *
 * Run with the dev env loaded so DATABASE_URL is present:
 *
 *   node --env-file=.env.dev --import tsx scripts/db-setup.ts
 *   # or: pnpm db:setup
 *
 * Steps:
 *   1. `prisma db push` the betterauth-only schema
 *      (packages/db/prisma/betterauth.prisma) so the betterauth.* tables exist
 *      with the exact columns BetterAuth queries. This must happen before the
 *      oweibo SQL migrations, because 001 attaches the betterauth_user_sync
 *      trigger to betterauth.users.
 *   2. Apply every packages/db/migrations/*.sql in filename order, tracked in
 *      public.schema_migrations so re-runs are incremental and safe.
 *
 * Idempotent: safe to run repeatedly. Files already recorded in
 * schema_migrations are skipped.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'db', 'migrations');

// `pg` is a dependency of @oweibo/db, not of the repo root, and Node resolves
// bare specifiers from the importing file's directory (scripts/), not cwd.
// Resolve it from the db package instead so this script needs no root dep.
const dbRequire = createRequire(path.join(REPO_ROOT, 'packages', 'db', 'package.json'));
const { Client } = dbRequire('pg') as typeof import('pg');

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required. Run via `pnpm db:setup` or with `node --env-file=.env.dev ...`.');
    process.exit(2);
  }

  // ── Step 1: betterauth.* tables via scoped prisma db push ──────────────────
  console.log('[db-setup] Step 1/2: creating betterauth.* tables (prisma db push)…');
  try {
    execSync(
      'pnpm --filter @oweibo/db exec prisma db push --schema prisma/betterauth.prisma --skip-generate --accept-data-loss',
      { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
    );
  } catch (err) {
    console.error('[db-setup] prisma db push (betterauth schema) failed.', err);
    process.exit(1);
  }

  // ── Step 2: apply oweibo SQL migrations in order ───────────────────────────
  console.log('[db-setup] Step 2/2: applying oweibo SQL migrations…');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM public.schema_migrations'))
        .rows.map((r) => r.filename),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[db-setup]   skip   ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      // Some migrations manage their own transactions (bare BEGIN;/COMMIT;)
      // and/or use CREATE INDEX CONCURRENTLY, which cannot run inside ANY
      // transaction — including the implicit one node-pg wraps around a
      // multi-statement simple query. Sending such a file as one query IS
      // that implicit transaction, so 000030-style migrations failed with
      // "CREATE INDEX CONCURRENTLY cannot run inside a transaction block".
      // Fix: split self-managed files into individual statements
      // (dollar-quote/comment/string aware) and run them sequentially on this
      // client — explicit BEGIN/COMMIT statements then open and close real
      // transactions, and CONCURRENTLY statements run in true autocommit.
      const selfManaged = /^\s*BEGIN\s*;/im.test(sql) || /CONCURRENTLY/i.test(sql);
      process.stdout.write(`[db-setup]   apply  ${file}${selfManaged ? ' (self-managed txn)' : ''} … `);
      try {
        if (selfManaged) {
          for (const stmt of splitSqlStatements(sql)) {
            await client.query(stmt);
          }
        } else {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
        }
      } catch (err) {
        // Roll back whichever transaction is open: the wrapper one, or a
        // self-managed file's own explicit BEGIN that never reached COMMIT.
        await client.query('ROLLBACK').catch(() => undefined);
        console.log('FAILED');
        console.error(`\n[db-setup] Migration ${file} failed:\n`, err);
        process.exit(1);
      }
      await client.query(
        'INSERT INTO public.schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file],
      );
      console.log('ok');
      ran++;
    }
    console.log(`[db-setup] Done. ${ran} migration(s) applied, ${files.length - ran} already current.`);
    console.log('[db-setup] Next: `pnpm gen:keys` (if not done) → start identity → `pnpm seed:admin`.');
  } finally {
    await client.end();
  }
}

/**
 * Split a migration file into individual SQL statements, respecting
 * single-quoted strings (with '' escapes), double-quoted identifiers,
 * dollar-quoted bodies ($$…$$ and $tag$…$tag$), line comments (-- …), and
 * block comments. Statements that are only whitespace/comments are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  const flush = (end: number) => {
    const stmt = sql.slice(start, end);
    // Drop chunks that contain no actual SQL (comments/whitespace only).
    const bare = stmt
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (bare.length > 0) statements.push(stmt.trim());
    start = end + 1;
  };

  while (i < n) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
    } else if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
    } else if (ch === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      i++;
    } else if (ch === '$') {
      // Possible dollar-quote opener: $tag$ where tag is [A-Za-z0-9_]*.
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
      } else {
        i++;
      }
    } else if (ch === ';') {
      flush(i);
      i++;
      start = i;
    } else {
      i++;
    }
  }
  flush(n);
  return statements;
}

main().catch((err: unknown) => {
  console.error('[db-setup] fatal:', err);
  process.exit(2);
});
