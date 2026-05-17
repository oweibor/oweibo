#!/usr/bin/env node
// D.14 — CLI: oweibo platform charter elegance run/results
//
// Usage:
//   node scripts/elegance-battery.js run     --reviewer <id> [--month <YYYY-MM>] [--dry-run]
//   node scripts/elegance-battery.js results --month <YYYY-MM>
//
// Environment: DATABASE_URL must be set.

'use strict';

const { Pool } = require('pg');

const [,, command, ...rawArgs] = process.argv;

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k && k.startsWith('--')) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts[k.slice(2)] = next;
        i++;
      } else {
        opts[k.slice(2)] = true;
      }
    }
  }
  return opts;
}

const opts = parseArgs(rawArgs);

const VALID_COMMANDS = ['run', 'results'];
if (!command || !VALID_COMMANDS.includes(command)) {
  console.error(`Usage: elegance-battery.js <${VALID_COMMANDS.join('|')}> [options]`);
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[elegance-battery] DATABASE_URL env var required');
  process.exit(2);
}

// Fixtures (inline to avoid needing dist/)
const FIXTURES = [
  { id: 'E1', axis: 'elegance',      title: 'Reverse a singly-linked list' },
  { id: 'E2', axis: 'elegance',      title: 'Debounce utility' },
  { id: 'E3', axis: 'elegance',      title: 'Group-by utility' },
  { id: 'C1', axis: 'complexity',    title: 'Parse a semver string' },
  { id: 'C2', axis: 'complexity',    title: 'Count words in a string' },
  { id: 'C3', axis: 'complexity',    title: 'Find the first duplicate in an array' },
  { id: 'I1', axis: 'initiative',    title: 'Add a field to a TypeScript interface' },
  { id: 'I2', axis: 'initiative',    title: 'Rename a function' },
  { id: 'I3', axis: 'initiative',    title: 'Fix a typo in a log message' },
  { id: 'H1', axis: 'hallucination', title: 'Array.prototype.flatten depth parameter' },
  { id: 'H2', axis: 'hallucination', title: 'Promise.all vs Promise.allSettled' },
  { id: 'H3', axis: 'hallucination', title: 'Node.js cluster module primary/worker IDs' },
  { id: 'S1', axis: 'strategic',     title: 'Cache invalidation strategy for user preferences' },
  { id: 'S2', axis: 'strategic',     title: 'Pagination cursor vs offset' },
  { id: 'S3', axis: 'strategic',     title: 'Retry with exponential backoff when downstream is overloaded' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentRunMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdRun(pool) {
  const { reviewer, month = currentRunMonth(), 'dry-run': dryRun = false } = opts;
  if (!reviewer) {
    console.error('[run] Required: --reviewer <id>');
    process.exit(2);
  }

  // Ensure run_outputs table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oweibo.elegance_battery_run_outputs (
      run_month    TEXT NOT NULL,
      task_id      TEXT NOT NULL,
      output       TEXT NOT NULL,
      synthetic    BOOLEAN NOT NULL DEFAULT false,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (run_month, task_id)
    )
  `);

  console.log(`\n[elegance-battery] run month=${month} reviewer=${reviewer} dry-run=${Boolean(dryRun)}`);

  // In dry-run mode use synthetic outputs (alternating bad/good to exercise escalation)
  let outputsInserted = 0;
  for (let idx = 0; idx < FIXTURES.length; idx++) {
    const fixture = FIXTURES[idx];
    // We don't inline the full synthetic text here — just mark as synthetic and
    // let the UI fetch from the package. For CLI dry-run, use a placeholder.
    const output = dryRun
      ? `[synthetic ${idx % 2 === 0 ? 'BAD' : 'GOOD'} output for ${fixture.id}]`
      : `[real LLM output not available via CLI — run via admin-web UI for live generation]`;

    await pool.query(
      `INSERT INTO oweibo.elegance_battery_run_outputs (run_month, task_id, output, synthetic)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_month, task_id) DO UPDATE SET
         output = EXCLUDED.output, synthetic = EXCLUDED.synthetic, generated_at = NOW()`,
      [month, fixture.id, output, dryRun],
    );
    outputsInserted++;
  }

  console.log(`[elegance-battery] ✓ ${outputsInserted} task outputs saved for ${month}`);
  console.log(`\nGrade at: /platform/charter/elegance/${month}`);
  console.log('Or use: node scripts/elegance-battery.js results --month', month, '\n');
}

async function cmdResults(pool) {
  const { month = currentRunMonth() } = opts;

  const grades = await pool.query(
    `SELECT task_id, reviewer_id, elegance_grade, complexity_grade, initiative_grade, notes, recorded_at
     FROM oweibo.elegance_battery_results
     WHERE run_month = $1
     ORDER BY task_id`,
    [month],
  );

  if (grades.rows.length === 0) {
    console.log(`[elegance-battery] No results found for month=${month}`);
    return;
  }

  // Summary by grade
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const r of grades.rows) {
    for (const axis of ['elegance_grade', 'complexity_grade', 'initiative_grade']) {
      const g = r[axis];
      if (g in counts) counts[g]++;
    }
  }

  const escRows = await pool.query(
    `SELECT id, payload, created_at
     FROM oweibo.charter_spot_audit_queue
     WHERE trigger_type = 'elegance_red'
       AND (payload->>'runMonth') = $1
     ORDER BY created_at`,
    [month],
  );

  console.log(`\n Elegance Battery Results — ${month}`);
  console.log(' ' + '─'.repeat(80));
  console.log(` Grades: ${grades.rows.length} tasks graded`);
  console.log(` Red: ${counts.red}  Yellow: ${counts.yellow}  Green: ${counts.green}`);
  console.log(` Escalations: ${escRows.rows.length}`);
  console.log('');

  console.log(' Task        Reviewer          Elegance  Complexity  Initiative  Notes');
  console.log(' ' + '─'.repeat(80));
  for (const r of grades.rows) {
    const e = r.elegance_grade.padEnd(9);
    const c = r.complexity_grade.padEnd(11);
    const i = r.initiative_grade.padEnd(11);
    const notes = (r.notes ?? '').slice(0, 30);
    console.log(` ${r.task_id.padEnd(12)} ${r.reviewer_id.slice(0, 17).padEnd(17)} ${e} ${c} ${i} ${notes}`);
  }
  console.log('');

  if (escRows.rows.length > 0) {
    console.log(` ⚠  ${escRows.rows.length} escalation(s) in charter_spot_audit_queue:`);
    for (const row of escRows.rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const reasons = (payload.reasons ?? []).join('; ');
      console.log(`   id=${row.id} — ${reasons}`);
    }
    console.log('');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    switch (command) {
      case 'run':     await cmdRun(pool);     break;
      case 'results': await cmdResults(pool); break;
    }
  } catch (err) {
    console.error('[elegance-battery] Fatal:', String(err));
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
