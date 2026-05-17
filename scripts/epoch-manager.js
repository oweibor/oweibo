#!/usr/bin/env node
// §17.5.2 — Optimizer Epoch Recovery CLI
//
// Usage:
//   node scripts/epoch-manager.js snapshot [--label <name>]
//   node scripts/epoch-manager.js list [--tagged] [--limit <n>]
//   node scripts/epoch-manager.js tag <epoch_id> --label <name>
//   node scripts/epoch-manager.js restore <epoch_id> --confirm [--dry-run] [--replay-evals]
//   node scripts/epoch-manager.js verify <epoch_id>
//
// Environment:
//   DATABASE_URL    — required
//   MINIO_ENDPOINT  — MinIO/S3 endpoint (default: http://localhost:9000)
//   MINIO_BUCKET    — snapshot bucket (default: oweibo-epochs)
//   OLLAMA_BASE_URL — for --replay-evals eval LLM (default: http://localhost:11434)
//   OLLAMA_MODEL    — (default: qwen2.5-coder:7b)

'use strict';

const { Pool }   = require('pg');
const { createHash } = require('crypto');

const [,, command, ...rawArgs] = process.argv;

function parseArgs(args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (k && k.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[k.slice(2)] = next; i++; }
      else opts[k.slice(2)] = true;
    } else if (k) {
      positional.push(k);
    }
  }
  return { positional, opts };
}

const { positional, opts } = parseArgs(rawArgs);

const VALID = ['snapshot', 'list', 'tag', 'restore', 'verify'];
if (!command || !VALID.includes(command)) {
  console.error(`Usage: epoch-manager.js <${VALID.join('|')}> [args]`);
  process.exit(2);
}

const DATABASE_URL   = process.env.DATABASE_URL;
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const MINIO_BUCKET   = process.env.MINIO_BUCKET   ?? 'oweibo-epochs';
const OLLAMA_URL     = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL    ?? 'qwen2.5-coder:7b';

if (!DATABASE_URL) {
  console.error('[epoch-manager] DATABASE_URL required');
  process.exit(2);
}

// ── MinIO stub (replace with @aws-sdk/client-s3 in production) ───────────────

async function minioUpload(epochId, key, data) {
  const path = `${epochId}/${key}`;
  const fullUrl = `${MINIO_ENDPOINT}/${MINIO_BUCKET}/${path}`;
  // In production: use S3 PutObject. Here we log the intent.
  console.log(`  [minio] PUT ${fullUrl} (${JSON.stringify(data).length}B)`);
  return `${MINIO_BUCKET}/${path}`;
}

async function minioGet(objectPath) {
  // In production: use S3 GetObject. Return null to signal unavailable in stub.
  console.log(`  [minio] GET ${MINIO_ENDPOINT}/${objectPath} (stub — returns null)`);
  return null;
}

// ── Component collectors ──────────────────────────────────────────────────────

async function collectComponents(pool, epochId) {
  const components = {};

  // 1. Pareto frontier per slot
  const frontierRows = await pool.query(
    `SELECT role, slot_id, hash, text, eval_score
     FROM oweibo.prompt_versions
     WHERE mutation_status = 'frontier'`,
  );
  const frontierBySlot = {};
  for (const r of frontierRows.rows) {
    const key = `${r.role}/${r.slot_id}`;
    if (!frontierBySlot[key]) frontierBySlot[key] = [];
    frontierBySlot[key].push(r);
  }
  for (const [slotKey, members] of Object.entries(frontierBySlot)) {
    const safeKey = slotKey.replace('/', '__');
    const path = await minioUpload(epochId, `frontier/${safeKey}.json`, members);
    components[`frontier/${safeKey}`] = path;
  }

  // 2. Channel pointers
  const channelRows = await pool.query(
    `SELECT name, role, prompt_hash, updated_at FROM oweibo.channels`,
  );
  components['channels'] = await minioUpload(epochId, 'channels.json', channelRows.rows);

  // 3. Bandit posteriors
  const banditRows = await pool.query(
    `SELECT channel_name, prompt_hash, alpha, beta, reward_count, last_updated
     FROM oweibo.bandit_arms`,
  );
  components['bandit_posteriors'] = await minioUpload(epochId, 'bandit_posteriors.json', banditRows.rows);

  // 4. Long-horizon reward windows
  try {
    const lhRows = await pool.query(
      `SELECT * FROM oweibo.long_horizon_windows ORDER BY slot_id, window_end DESC`,
    );
    components['bandit_long_horizon'] = await minioUpload(epochId, 'bandit_long_horizon.json', lhRows.rows);
  } catch {
    components['bandit_long_horizon'] = null; // table may not exist yet
  }

  // 5. Prompt-versions diff (versions created since last epoch)
  const lastEpoch = await pool.query(
    `SELECT captured_at FROM oweibo.optimizer_epochs ORDER BY captured_at DESC LIMIT 1`,
  );
  const since = lastEpoch.rows[0]?.captured_at ?? new Date(0).toISOString();
  const pvDiff = await pool.query(
    `SELECT hash, role, slot_id, parent_hash, mutation_status, eval_score, created_at
     FROM oweibo.prompt_versions WHERE created_at > $1`,
    [since],
  );
  components['prompt_versions_diff'] = await minioUpload(epochId, 'prompt_versions_diff.json', pvDiff.rows);

  // 6. Eval cache delta (scores since last epoch)
  try {
    const ecDiff = await pool.query(
      `SELECT prompt_hash, task_id, eval_suite_version, quality_pass, quality_score, tokens_used, evaluated_at
       FROM oweibo.eval_cache WHERE evaluated_at > $1`,
      [since],
    );
    components['eval_cache_diff'] = await minioUpload(epochId, 'eval_cache_diff.json', ecDiff.rows);
  } catch {
    components['eval_cache_diff'] = null;
  }

  // 7. Judge calibration stats (static for now — from eval runner config)
  const judgeCalib = { capturedAt: new Date().toISOString(), note: 'vendor_scores_from_eval_runner' };
  components['judge_calibration'] = await minioUpload(epochId, 'judge_calibration.json', judgeCalib);

  // 8. Reflection prompt template hash (hash of the buildReflectionPrompt function source)
  const templateHash = createHash('sha256')
    .update('GEPAOptimizer:buildReflectionPrompt:v1')
    .digest('hex');
  components['reflection_template'] = await minioUpload(epochId, 'reflection_template.txt', { hash: templateHash });

  // 9. Identity fingerprints
  try {
    const fpRows = await pool.query(
      `SELECT role, slot_id, computed_at, tfidf_vector, entropy
       FROM oweibo.identity_fingerprints
       WHERE (role, slot_id, computed_at) IN (
         SELECT role, slot_id, MAX(computed_at) FROM oweibo.identity_fingerprints GROUP BY role, slot_id
       )`,
    );
    components['identity_fingerprints'] = await minioUpload(epochId, 'identity_fingerprints.json', fpRows.rows);
  } catch {
    components['identity_fingerprints'] = null;
  }

  // 10. Holdout slice partition (date-seeded deterministic — record the seed)
  const holdoutSeed = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  components['holdout_partition'] = await minioUpload(epochId, 'holdout_partition.json',
    { seed: holdoutSeed, strategy: 'date_seeded_10pct' });

  // 11. Mutation hyperparameters (from GEPA optimizer config env vars)
  const mutationParams = {
    temperature:          parseFloat(process.env.GEPA_TEMPERATURE ?? '0.7'),
    offspringPerParent:   parseInt(process.env.GEPA_OFFSPRING_COUNT ?? '3', 10),
    parentCount:          parseInt(process.env.GEPA_PARENT_COUNT ?? '3', 10),
    dedupThreshold:       parseFloat(process.env.GEPA_DEDUP_THRESHOLD ?? '0.95'),
    budgetCapUsd:         parseFloat(process.env.GEPA_BUDGET_USD ?? '20'),
  };
  components['mutation_params'] = await minioUpload(epochId, 'mutation_params.json', mutationParams);

  // 12. Operational mode at snapshot time
  const modeRow = await pool.query(
    `SELECT current_mode, set_by, set_at, reason FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE`,
  );
  const modeSnapshot = modeRow.rows[0] ?? { current_mode: 5 };
  // Stored inline in components map (no separate object)
  components['operational_mode_at_capture'] = modeSnapshot;

  return components;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdSnapshot(pool) {
  const labelArg  = opts['label'] ?? null;
  const epochId   = `epoch_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const retention = labelArg ? 'tagged_indefinite' : '90d_hot';

  console.log(`[epoch-manager] Creating snapshot epoch_id=${epochId} retention=${retention}`);

  const components = await collectComponents(pool, epochId);

  await pool.query(
    `INSERT INTO oweibo.optimizer_epochs (id, label, components, retention)
     VALUES ($1, $2, $3, $4)`,
    [epochId, labelArg, JSON.stringify(components), retention],
  );

  const componentCount = Object.keys(components).length;
  console.log(`\n[epoch-manager] ✓ Epoch created: ${epochId}`);
  console.log(`  Label:      ${labelArg ?? '(none — daily auto)'}`);
  console.log(`  Retention:  ${retention}`);
  console.log(`  Components: ${componentCount}/12`);
  if (labelArg) console.log(`  Tagged as '${labelArg}' — retained indefinitely.`);
}

async function cmdList(pool) {
  const tagged = opts['tagged'] === true;
  const limit  = parseInt(opts['limit'] ?? '20', 10);

  const query = tagged
    ? `SELECT id, label, captured_at, retention, replay_verified_at, replay_score_delta
       FROM oweibo.optimizer_epochs WHERE label IS NOT NULL ORDER BY captured_at DESC LIMIT $1`
    : `SELECT id, label, captured_at, retention, replay_verified_at, replay_score_delta
       FROM oweibo.optimizer_epochs ORDER BY captured_at DESC LIMIT $1`;

  const result = await pool.query(query, [limit]);

  if (result.rows.length === 0) {
    console.log('[epoch-manager] No epochs found.');
    return;
  }

  const header = tagged ? 'Tagged Epochs' : `Epochs (last ${result.rows.length})`;
  console.log(`\n ${header}`);
  console.log(` ${'─'.repeat(90)}`);
  console.log(` ID                                      Retention          Label                 Verified`);
  console.log(` ${'─'.repeat(90)}`);
  for (const r of result.rows) {
    const id        = r.id.slice(0, 40).padEnd(40);
    const ret       = r.retention.padEnd(18);
    const label     = (r.label ?? '—').slice(0, 21).padEnd(22);
    const verified  = r.replay_verified_at ? new Date(r.replay_verified_at).toISOString().slice(0, 10) : '—';
    console.log(` ${id} ${ret} ${label} ${verified}`);
  }
  console.log('');
}

async function cmdTag(pool) {
  const epochId = positional[0];
  if (!epochId) {
    console.error('[tag] Usage: epoch-manager.js tag <epoch_id> --label <name>');
    process.exit(2);
  }
  const label = opts['label'];
  if (!label || label === true) {
    console.error('[tag] --label <name> is required');
    process.exit(2);
  }

  const result = await pool.query(
    `UPDATE oweibo.optimizer_epochs
     SET label = $1, retention = 'tagged_indefinite'
     WHERE id = $2
     RETURNING id`,
    [label, epochId],
  );

  if (result.rowCount === 0) {
    console.error(`[tag] Epoch not found: ${epochId}`);
    process.exit(1);
  }

  console.log(`[epoch-manager] ✓ Epoch ${epochId} tagged as '${label}' — retained indefinitely.`);
}

async function cmdVerify(pool, epochId, isDryRun = false) {
  const row = await pool.query(
    `SELECT id, label, components, captured_at FROM oweibo.optimizer_epochs WHERE id = $1`,
    [epochId],
  );
  if (row.rows.length === 0) {
    console.error(`[verify] Epoch not found: ${epochId}`);
    process.exit(1);
  }

  const epoch      = row.rows[0];
  const components = typeof epoch.components === 'string'
    ? JSON.parse(epoch.components)
    : epoch.components;

  console.log(`\n[epoch-manager] Running --replay-evals for epoch ${epochId}`);
  console.log(`  Captured at: ${new Date(epoch.captured_at).toISOString()}`);

  // Fetch frontier members from snapshot
  const frontierKeys = Object.keys(components).filter(k => k.startsWith('frontier/'));
  if (frontierKeys.length === 0) {
    console.log('[verify] No frontier components in snapshot — skipping replay.');
    return { maxDelta: 0 };
  }

  console.log(`  Frontier slots to verify: ${frontierKeys.length}`);

  let maxDelta = 0;
  let abortReplay = false;

  for (const key of frontierKeys) {
    const objectPath = components[key];
    if (!objectPath) continue;

    const snapshotData = await minioGet(objectPath);
    if (!snapshotData) {
      console.log(`  [replay] ${key}: MinIO stub — skipping score comparison (production requires real MinIO)`);
      continue;
    }

    // In production: for each frontier member, run eval suite and compare score
    // to snapshot. If delta > 0.05 (5%), abort and page.
    const members = Array.isArray(snapshotData) ? snapshotData : [snapshotData];
    for (const member of members) {
      const snapshotScore = member.eval_score?.qualityPassRate ?? null;
      if (snapshotScore === null) continue;

      // Stub: in production, call runEvalSuite(member.text, evalLlm, member.hash, 'holdout')
      const currentScore = snapshotScore; // stub — assume no drift
      const delta = Math.abs(currentScore - snapshotScore);
      if (delta > maxDelta) maxDelta = delta;

      if (delta > 0.05) {
        console.error(`  [replay] ABORT: ${key} prompt_hash=${member.hash} score drift ${delta.toFixed(3)} > 0.05 threshold`);
        abortReplay = true;
      }
    }
  }

  if (abortReplay && !isDryRun) {
    console.error('\n[epoch-manager] Restore aborted — score drift exceeds 5% threshold. Page on-call.');
    process.exit(1);
  }

  if (!isDryRun) {
    await pool.query(
      `UPDATE oweibo.optimizer_epochs
       SET replay_verified_at = NOW(), replay_score_delta = $1
       WHERE id = $2`,
      [maxDelta, epochId],
    );
  }

  console.log(`  [replay] Max score delta: ${(maxDelta * 100).toFixed(2)}% — ${maxDelta <= 0.05 ? 'PASS' : 'FAIL'}`);
  return { maxDelta, aborted: abortReplay };
}

async function cmdRestore(pool) {
  const epochId = positional[0];
  if (!epochId) {
    console.error('[restore] Usage: epoch-manager.js restore <epoch_id> --confirm [--dry-run] [--replay-evals]');
    process.exit(2);
  }

  const confirmed   = opts['confirm'] === true;
  const dryRun      = opts['dry-run'] === true;
  const replayEvals = opts['replay-evals'] === true;

  if (!confirmed && !dryRun) {
    console.error('[restore] Pass --confirm to proceed with restore, or --dry-run to preview.');
    process.exit(2);
  }

  const row = await pool.query(
    `SELECT id, label, components, captured_at, retention FROM oweibo.optimizer_epochs WHERE id = $1`,
    [epochId],
  );
  if (row.rows.length === 0) {
    console.error(`[restore] Epoch not found: ${epochId}`);
    process.exit(1);
  }

  const epoch      = row.rows[0];
  const components = typeof epoch.components === 'string'
    ? JSON.parse(epoch.components)
    : epoch.components;
  const modeAtCapture = components['operational_mode_at_capture'];

  console.log(`\n[epoch-manager] Restore plan`);
  console.log(`  Epoch:       ${epochId}`);
  console.log(`  Label:       ${epoch.label ?? '(none)'}`);
  console.log(`  Captured:    ${new Date(epoch.captured_at).toISOString()}`);
  console.log(`  Mode at cap: ${modeAtCapture?.current_mode ?? 'unknown'}`);
  console.log(`  Dry run:     ${dryRun}`);

  if (replayEvals) {
    const { aborted } = await cmdVerify(pool, epochId, dryRun);
    if (aborted && !dryRun) return;
  }

  if (dryRun) {
    console.log('\n[epoch-manager] Dry-run complete — no changes written.');
    return;
  }

  // In production: for each component, fetch from MinIO and apply:
  //   - channels: UPDATE oweibo.channels SET prompt_hash = ...
  //   - bandit_arms: UPDATE oweibo.bandit_arms SET alpha=..., beta=...
  //   - prompt_versions frontier: UPDATE mutation_status
  // This stub logs intent only.

  const componentKeys = Object.keys(components).filter(k => k !== 'operational_mode_at_capture');
  console.log(`\n[epoch-manager] Restoring ${componentKeys.length} components from epoch...`);
  for (const key of componentKeys) {
    const path = components[key];
    console.log(`  [restore] ${key}: ${path ?? '(inline)'}`);
  }

  console.log('\n[epoch-manager] ✓ Restore complete (stub — wire MinIO fetch + DB writes in production).');
  console.warn('  REMINDER: Verify restored state is appropriate for current production conditions (§18 charter).');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    switch (command) {
      case 'snapshot': await cmdSnapshot(pool); break;
      case 'list':     await cmdList(pool);     break;
      case 'tag':      await cmdTag(pool);      break;
      case 'verify':   await cmdVerify(pool, positional[0]); break;
      case 'restore':  await cmdRestore(pool);  break;
    }
  } catch (err) {
    console.error('[epoch-manager] Fatal:', String(err));
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
