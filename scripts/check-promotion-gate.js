#!/usr/bin/env node
// D.9 — CI gate: checks cohort_promotion_rules before a channel promotion lands.
// Usage:
//   node scripts/check-promotion-gate.js \
//     --from fast --to beta \
//     --slot decomposition_rules --arm <hash> \
//     --prompt-hash <hash> \
//     [--human-approved]
//
// Exit 0 → all gate checks pass (promotion allowed).
// Exit 1 → one or more gate checks failed (promotion blocked).
//
// Called from CI on any PR that touches oweibo.channels rows.

'use strict';

const { Pool } = require('pg');

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--human-approved') { opts.humanApproved = true; continue; }
    if (key.startsWith('--')) {
      opts[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[++i];
    }
  }
  return opts;
}

const opts = parseArgs();
const { from: fromChannel, to: toChannel, slot: slotId, arm: armId, promptHash } = opts;
const humanApproved = opts.humanApproved === true;

if (!fromChannel || !toChannel || !slotId || !armId) {
  console.error('[promotion-gate] Required: --from, --to, --slot, --arm');
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[promotion-gate] DATABASE_URL env var required');
  process.exit(2);
}

// ── Gate logic ────────────────────────────────────────────────────────────────

async function runGate(pool) {
  // Load promotion rules
  const rulesRes = await pool.query(
    `SELECT soak_days, min_completions, min_quality_delta,
            max_safety_violations, requires_human_approval
     FROM oweibo.cohort_promotion_rules
     WHERE from_channel = $1 AND to_channel = $2`,
    [fromChannel, toChannel],
  );

  if (rulesRes.rows.length === 0) {
    console.error(`[promotion-gate] ✗ No rules for ${fromChannel} → ${toChannel}`);
    return false;
  }

  const rules = rulesRes.rows[0];
  const checks = [];

  // Soak days
  const soakRes = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(bae.recorded_at))) / 86400 AS days
     FROM oweibo.bandit_arm_events bae
     WHERE bae.slot_id = $1 AND bae.arm_id = $2`,
    [slotId, armId],
  );
  const days = parseFloat(soakRes.rows[0]?.days ?? '0');
  const soakOk = days >= rules.soak_days;
  checks.push({ name: 'soak_days', ok: soakOk, msg: `${days.toFixed(1)}d / ${rules.soak_days}d required` });

  // Min completions
  const compRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM oweibo.bandit_arm_events WHERE slot_id = $1 AND arm_id = $2`,
    [slotId, armId],
  );
  const completions = parseInt(compRes.rows[0]?.cnt ?? '0', 10);
  const compOk = completions >= rules.min_completions;
  checks.push({ name: 'min_completions', ok: compOk, msg: `${completions} / ${rules.min_completions} required` });

  // Safety violations (reward=0 events)
  const safetyRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM oweibo.bandit_arm_events
     WHERE slot_id = $1 AND arm_id = $2 AND reward = 0`,
    [slotId, armId],
  );
  const violations = parseInt(safetyRes.rows[0]?.cnt ?? '0', 10);
  const safetyOk = violations <= rules.max_safety_violations;
  checks.push({ name: 'safety_violations', ok: safetyOk, msg: `${violations} violations / max ${rules.max_safety_violations}` });

  // Human approval (if required)
  if (rules.requires_human_approval) {
    const humanOk = humanApproved;
    checks.push({ name: 'human_approval', ok: humanOk, msg: humanOk ? 'provided' : 'REQUIRED but not passed (use --human-approved)' });
  }

  // Report
  console.log(`\n[promotion-gate] ${fromChannel} → ${toChannel}  slot=${slotId}  arm=${armId}\n`);
  let allPassed = true;
  for (const c of checks) {
    const icon = c.ok ? '✓' : '✗';
    console.log(`  ${icon} ${c.name.padEnd(22)} ${c.msg}`);
    if (!c.ok) allPassed = false;
  }
  console.log('');

  if (allPassed) {
    console.log('[promotion-gate] All checks PASSED — promotion is allowed.\n');
  } else {
    const failed = checks.filter(c => !c.ok).map(c => c.name).join(', ');
    console.error(`[promotion-gate] BLOCKED by: ${failed}\n`);
  }

  return allPassed;
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    const allowed = await runGate(pool);
    process.exit(allowed ? 0 : 1);
  } catch (err) {
    console.error('[promotion-gate] Fatal error:', String(err));
    process.exit(2);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
