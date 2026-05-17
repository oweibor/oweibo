#!/usr/bin/env node
// D.12 — CLI: oweibo platform prompts freeze/unfreeze/guard
//
// Usage:
//   node scripts/platform-prompts.js freeze  --slot <slot_id> --role <role> --reason <text> [--rfc <url>] [--by <user>]
//   node scripts/platform-prompts.js unfreeze --slot <slot_id> --role <role> --reason <text>  [--by <user>]
//   node scripts/platform-prompts.js guard    --slot <slot_id> --role <role> --reason <text>  [--by <user>]
//   node scripts/platform-prompts.js list     [--role <role>] [--status mutable|guarded|frozen]
//
// Environment: DATABASE_URL must be set.

'use strict';

const { Pool } = require('pg');

// ── Arg parsing ───────────────────────────────────────────────────────────────

const [,, command, ...rawArgs] = process.argv;

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k && k.startsWith('--')) {
      opts[k.slice(2)] = args[++i] ?? true;
    }
  }
  return opts;
}

const opts = parseArgs(rawArgs);

const VALID_COMMANDS = ['freeze', 'unfreeze', 'guard', 'list'];
if (!command || !VALID_COMMANDS.includes(command)) {
  console.error(`Usage: platform-prompts.js <${VALID_COMMANDS.join('|')}> [options]`);
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[platform-prompts] DATABASE_URL env var required');
  process.exit(2);
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function cmdFreeze(pool) {
  const { slot, role, reason, rfc, by = 'cli' } = opts;
  if (!slot || !role || !reason) {
    console.error('[freeze] Required: --slot, --role, --reason');
    process.exit(2);
  }
  return setStatus(pool, slot, role, 'frozen', reason, by, rfc, { requireRfc: true });
}

async function cmdUnfreeze(pool) {
  const { slot, role, reason, by = 'cli' } = opts;
  if (!slot || !role || !reason) {
    console.error('[unfreeze] Required: --slot, --role, --reason');
    process.exit(2);
  }
  return setStatus(pool, slot, role, 'mutable', reason, by, undefined, {});
}

async function cmdGuard(pool) {
  const { slot, role, reason, rfc, by = 'cli' } = opts;
  if (!slot || !role || !reason) {
    console.error('[guard] Required: --slot, --role, --reason');
    process.exit(2);
  }
  return setStatus(pool, slot, role, 'guarded', reason, by, rfc, {});
}

async function setStatus(pool, slotId, role, newStatus, reason, changedBy, rfcUrl, { requireRfc }) {
  if (requireRfc && !rfcUrl) {
    console.error(`[platform-prompts] freeze requires --rfc <url> (Mutation-Freeze RFC link)`);
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current status
    const cur = await client.query(
      `SELECT hash, mutation_status, freeze_reason
       FROM oweibo.prompt_versions
       WHERE slot_id = $1 AND role = $2
       ORDER BY created_at DESC LIMIT 1`,
      [slotId, role],
    );

    if (cur.rows.length === 0) {
      console.error(`[platform-prompts] No prompt_versions found for slot=${slotId} role=${role}`);
      process.exit(1);
    }

    const prev = cur.rows[0];
    if (prev.mutation_status === newStatus) {
      console.log(`[platform-prompts] slot=${slotId} role=${role} already ${newStatus} — no change.`);
      await client.query('ROLLBACK');
      return;
    }

    // Update all versions for this slot+role
    const updated = await client.query(
      `UPDATE oweibo.prompt_versions
       SET mutation_status = $1, freeze_reason = $2
       WHERE slot_id = $3 AND role = $4`,
      [newStatus, newStatus !== 'mutable' ? reason : null, slotId, role],
    );

    // Write audit log
    await client.query(
      `INSERT INTO oweibo.prompt_slot_mutation_history
         (slot_id, role, previous_status, new_status, reason, rfc_url, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [slotId, role, prev.mutation_status, newStatus, reason, rfcUrl ?? null, changedBy],
    );

    await client.query('COMMIT');

    console.log(`\n[platform-prompts] ✓ ${prev.mutation_status} → ${newStatus}`);
    console.log(`  slot:    ${slotId}`);
    console.log(`  role:    ${role}`);
    console.log(`  rows:    ${updated.rowCount}`);
    console.log(`  reason:  ${reason}`);
    if (rfcUrl) console.log(`  rfc:     ${rfcUrl}`);
    console.log(`  by:      ${changedBy}\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cmdList(pool) {
  const { role, status } = opts;
  const conditions = [];
  const params = [];
  if (role)   { conditions.push(`role = $${params.length + 1}`);            params.push(role); }
  if (status) { conditions.push(`mutation_status = $${params.length + 1}`); params.push(status); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT DISTINCT slot_id, role, mutation_status, freeze_reason
     FROM oweibo.prompt_versions ${where}
     ORDER BY role, slot_id`,
    params,
  );

  if (result.rows.length === 0) {
    console.log('[platform-prompts] No slots found.');
    return;
  }

  console.log('\n Slot ID                          Role          Status     Reason');
  console.log(' ' + '─'.repeat(90));
  for (const r of result.rows) {
    const statusIcon = r.mutation_status === 'frozen' ? '❄' : r.mutation_status === 'guarded' ? '🛡' : '✓';
    const reason = (r.freeze_reason ?? '').slice(0, 40);
    console.log(` ${statusIcon} ${r.slot_id.padEnd(32)} ${r.role.padEnd(13)} ${r.mutation_status.padEnd(10)} ${reason}`);
  }
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    switch (command) {
      case 'freeze':   await cmdFreeze(pool);   break;
      case 'unfreeze': await cmdUnfreeze(pool); break;
      case 'guard':    await cmdGuard(pool);    break;
      case 'list':     await cmdList(pool);     break;
    }
  } catch (err) {
    console.error('[platform-prompts] Fatal:', String(err));
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
