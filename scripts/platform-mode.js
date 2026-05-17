#!/usr/bin/env node
// §17.5.1 — CLI: oweibo platform mode get/set/history
//
// Usage:
//   node scripts/platform-mode.js get
//   node scripts/platform-mode.js set <0-5> --reason <text> [--by <user>] [--auto-trigger <label>]
//   node scripts/platform-mode.js history [--limit <n>]
//
// Environment: DATABASE_URL must be set.

'use strict';

const { Pool } = require('pg');

const [,, command, ...rawArgs] = process.argv;

function parseArgs(args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k && k.startsWith('--')) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) { opts[k.slice(2)] = next; i++; }
      else opts[k.slice(2)] = true;
    } else if (k) {
      positional.push(k);
    }
  }
  return { positional, opts };
}

const { positional, opts } = parseArgs(rawArgs);

const VALID_COMMANDS = ['get', 'set', 'history'];
if (!command || !VALID_COMMANDS.includes(command)) {
  console.error(`Usage: platform-mode.js <${VALID_COMMANDS.join('|')}> [args]`);
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[platform-mode] DATABASE_URL env var required');
  process.exit(2);
}

const MODE_NAMES = {
  5: 'Full operation',
  4: 'Eval-only',
  3: 'No bandit learning',
  2: 'No GEPA mutations',
  1: 'No promotions',
  0: 'Full freeze (stable-v0 only)',
};

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdGet(pool) {
  const result = await pool.query(
    `SELECT current_mode, set_by, set_at, reason, auto_trigger
     FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE`,
  );
  if (result.rows.length === 0) {
    console.log('[platform-mode] No operational mode row found — table may not be migrated yet');
    return;
  }
  const row = result.rows[0];
  const modeName = MODE_NAMES[row.current_mode] ?? 'Unknown';
  const trigger = row.auto_trigger ? ` [auto: ${row.auto_trigger}]` : '';

  console.log(`\n Platform Operational Mode`);
  console.log(` ${'─'.repeat(50)}`);
  console.log(` Mode:     ${row.current_mode} — ${modeName}${trigger}`);
  console.log(` Set by:   ${row.set_by}`);
  console.log(` Set at:   ${new Date(row.set_at).toISOString()}`);
  console.log(` Reason:   ${row.reason}\n`);
}

async function cmdSet(pool) {
  const modeArg = positional[0];
  if (modeArg === undefined || modeArg === null) {
    console.error('[set] Usage: platform-mode.js set <0-5> --reason <text> [--by <user>]');
    process.exit(2);
  }
  const newMode = parseInt(modeArg, 10);
  if (isNaN(newMode) || newMode < 0 || newMode > 5) {
    console.error(`[set] Mode must be 0-5, got: ${modeArg}`);
    process.exit(2);
  }
  const reason = opts['reason'];
  if (!reason || reason === true) {
    console.error('[set] --reason <text> is required');
    process.exit(2);
  }
  const setBy       = opts['by'] ?? process.env.USER ?? 'cli';
  const autoTrigger = opts['auto-trigger'] ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(
      `SELECT current_mode FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE FOR UPDATE`,
    );
    const fromMode = current.rows[0]?.current_mode ?? 5;

    if (fromMode === newMode) {
      console.log(`[platform-mode] Already at mode ${newMode} (${MODE_NAMES[newMode]}) — no change.`);
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE oweibo.platform_operational_mode
       SET current_mode = $1, set_by = $2, set_at = NOW(), reason = $3, auto_trigger = $4
       WHERE singleton_id = TRUE`,
      [newMode, setBy, reason, autoTrigger],
    );

    await client.query(
      `INSERT INTO oweibo.operational_mode_transitions
         (from_mode, to_mode, set_by, reason, auto_trigger)
       VALUES ($1, $2, $3, $4, $5)`,
      [fromMode, newMode, setBy, reason, autoTrigger],
    );

    await client.query('COMMIT');

    const dir = newMode > fromMode ? '↑' : '↓';
    console.log(`\n[platform-mode] ✓ ${fromMode} (${MODE_NAMES[fromMode]}) ${dir} ${newMode} (${MODE_NAMES[newMode]})`);
    console.log(`  by:     ${setBy}`);
    console.log(`  reason: ${reason}`);
    if (autoTrigger) console.log(`  trigger: ${autoTrigger}`);
    console.log('');

    if (newMode <= 1) {
      console.warn(`  ⚠  Mode ${newMode} — recovery requires explicit human action to raise mode back.`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cmdHistory(pool) {
  const limit = parseInt(opts['limit'] ?? '20', 10);
  const result = await pool.query(
    `SELECT id, from_mode, to_mode, set_by, set_at, reason, auto_trigger
     FROM oweibo.operational_mode_transitions
     ORDER BY set_at DESC LIMIT $1`,
    [limit],
  );

  if (result.rows.length === 0) {
    console.log('[platform-mode] No transitions recorded yet.');
    return;
  }

  console.log(`\n Mode Transition History (last ${result.rows.length})`);
  console.log(` ${'─'.repeat(80)}`);
  console.log(` When                       From → To   By                   Reason`);
  console.log(` ${'─'.repeat(80)}`);
  for (const r of result.rows) {
    const when   = new Date(r.set_at).toISOString().slice(0, 19).replace('T', ' ');
    const change = `${r.from_mode}→${r.to_mode}`.padEnd(7);
    const by     = (r.set_by ?? '').slice(0, 20).padEnd(20);
    const reason = (r.reason ?? '').slice(0, 35);
    const trigger = r.auto_trigger ? ` [auto:${r.auto_trigger}]` : '';
    console.log(` ${when}  ${change}  ${by}  ${reason}${trigger}`);
  }
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    switch (command) {
      case 'get':     await cmdGet(pool);     break;
      case 'set':     await cmdSet(pool);     break;
      case 'history': await cmdHistory(pool); break;
    }
  } catch (err) {
    console.error('[platform-mode] Fatal:', String(err));
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
