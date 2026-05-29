#!/usr/bin/env tsx
/**
 * check-security-definer-search-path.ts
 *
 * CI gate: every SECURITY DEFINER function defined in packages/db/migrations/
 * must pin its search_path. An unpinned search_path is the classic privilege-
 * escalation vector — a caller can prepend a malicious schema, shadow built-in
 * functions, and execute attacker code in the function owner's context.
 *
 * Algorithm
 * ─────────
 * Migrations are read in filename order (== chronological, since the project
 * uses YYYYMMDD_NNNN prefixes). Each `CREATE [OR REPLACE] FUNCTION` block is
 * extracted and we track, per fully-qualified function name, the LATEST
 * definition: did it declare both SECURITY DEFINER and SET search_path?
 *
 * A function is allowed to start unpinned in an old migration as long as a
 * later migration re-creates it with the pin (so migration 001 doesn't need
 * to be rewritten — a follow-up migration can lock it down).
 *
 * Fails the build if the latest definition of any SECURITY DEFINER function
 * lacks `SET search_path = ...` in its declaration.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'packages/db/migrations');

interface FnState {
  fqName:        string;
  migration:     string;
  isDefiner:     boolean;
  hasSearchPath: boolean;
}

/**
 * Extract each top-level `CREATE [OR REPLACE] FUNCTION` block from a migration.
 *
 * PostgreSQL function attributes (LANGUAGE, SECURITY DEFINER, STABLE, SET
 * search_path, AS $$...$$) may appear in any order in the declaration. We
 * therefore capture the entire definition — from `CREATE` through the
 * terminating `;` at top level — and inspect attribute flags across the
 * whole block. Dollar-quoted bodies (`$$...$$` or `$tag$...$tag$`) are
 * treated as opaque so a `;` inside the function body does not terminate
 * the outer declaration.
 */
function extractFunctions(sql: string, migration: string): FnState[] {
  const fns: FnState[] = [];
  const startRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(/gi;

  let m: RegExpExecArray | null;
  while ((m = startRe.exec(sql)) !== null) {
    const fqName = m[1]!;
    const start  = m.index;

    // Walk forward to find the terminating `;` outside any dollar-quoted body.
    let i = startRe.lastIndex;
    let inDollar: string | null = null;  // active dollar-tag, e.g. "$$" or "$body$"
    while (i < sql.length) {
      if (inDollar) {
        const end = sql.indexOf(inDollar, i);
        if (end < 0) { i = sql.length; break; }
        i = end + inDollar.length;
        inDollar = null;
        continue;
      }
      // Look for a dollar-tag start: $...$
      if (sql[i] === '$') {
        const tagMatch = /^\$\w*\$/.exec(sql.slice(i));
        if (tagMatch) {
          inDollar = tagMatch[0];
          i += inDollar.length;
          continue;
        }
      }
      if (sql[i] === ';') { i++; break; }
      i++;
    }

    const block = sql.slice(start, i);
    const isDefiner     = /\bSECURITY\s+DEFINER\b/i.test(block);
    const hasSearchPath = /\bSET\s+search_path\s*=/i.test(block);
    fns.push({ fqName, migration, isDefiner, hasSearchPath });

    // Continue scanning after the end of this declaration.
    startRe.lastIndex = i;
  }

  return fns;
}

function main(): void {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();  // filename order == chronological for YYYYMMDD_NNNN names

  // fqName -> latest state across all migrations
  const latest = new Map<string, FnState>();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const fns = extractFunctions(sql, file);
    for (const fn of fns) {
      latest.set(fn.fqName, fn);
    }
  }

  const offenders: FnState[] = [];
  for (const state of latest.values()) {
    if (state.isDefiner && !state.hasSearchPath) {
      offenders.push(state);
    }
  }

  if (offenders.length === 0) {
    const definerCount = Array.from(latest.values()).filter(s => s.isDefiner).length;
    console.log(`✓ check-security-definer-search-path: ${definerCount} SECURITY DEFINER function(s) have pinned search_path.`);
    process.exit(0);
  }

  console.error('✗ check-security-definer-search-path: SECURITY DEFINER functions without pinned search_path:');
  console.error('');
  for (const o of offenders) {
    console.error(`  ${o.fqName}  (latest definition: ${o.migration})`);
  }
  console.error('');
  console.error('Add `SET search_path = oweibo, pg_temp` (or schemas appropriate to the function)');
  console.error('to the function header. Without a pinned search_path, a caller can shadow');
  console.error('built-in functions with their own schema and execute code in the function');
  console.error('owner\'s privilege context.');
  process.exit(1);
}

main();
