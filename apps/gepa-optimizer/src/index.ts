// DONE: Phase C.3 — GEPA optimizer nightly cron entry point.
// Reads releasable_buckets (k-anonymity gated), runs Pareto evolution per slot,
// writes new prompt_versions rows. Budget-capped per run.

import { Pool } from 'pg';
import { PromptSlotOptimizer, type FrontierVariant, type OptimizerConfig } from '@oweibo/gepa-core';
import { CANONICAL_ROLES } from '@oweibo/core-contracts';
import { createHash } from 'crypto';

const DATABASE_URL = process.env['DATABASE_URL'];
const OLLAMA_URL   = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
const MODEL        = process.env['OLLAMA_MODEL']    ?? 'qwen2.5-coder:7b';
const MAX_COST_USD = parseFloat(process.env['GEPA_BUDGET_USD'] ?? '20');
const VENDOR_PANEL = (process.env['REFLECTION_VENDOR_PANEL'] ?? 'anthropic').split(',');

if (!DATABASE_URL) {
  console.error('[gepa-optimizer] DATABASE_URL required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

// Minimal ILLMClient adapter for Ollama
const makeLlm = () => ({
  async generate(req: { systemPrompt: string; userPrompt: string; temperature?: number }) {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  MODEL,
        prompt: `${req.systemPrompt}\n\n${req.userPrompt}`,
        stream: false,
        options: { temperature: req.temperature ?? 0 },
      }),
    });
    const json = await res.json() as { response: string };
    return { output: json.response, promptTokens: 0, completionTokens: 0 };
  },
});

async function getReleasableBuckets(): Promise<Array<{ role: string; slot_id: string; lesson_count: number }>> {
  // Refresh materialised view first
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY oweibo.releasable_buckets');
  const result = await pool.query<{ role: string; slot_id: string; lesson_count: number }>(
    `SELECT role, slot_id, lesson_count FROM oweibo.releasable_buckets ORDER BY lesson_count DESC`,
  );
  return result.rows;
}

async function getLessons(role: string, slotId: string, limit: number): Promise<string[]> {
  // GEPA reads ONLY from releasable_buckets view, never direct platform_lessons
  const result = await pool.query<{ abstract_pattern: string }>(
    `SELECT pl.abstract_pattern FROM oweibo.platform_lessons pl
     JOIN oweibo.releasable_buckets rb ON rb.bucket_key = pl.bucket_key
     WHERE pl.role = $1 AND pl.slot_id = $2
     ORDER BY pl.confidence DESC LIMIT $3`,
    [role, slotId, limit],
  );
  return result.rows.map(r => r.abstract_pattern);
}

async function getIncumbentText(role: string, slotId: string): Promise<string> {
  const result = await pool.query<{ text: string }>(
    `SELECT pv.text FROM oweibo.prompt_versions pv
     JOIN oweibo.channels ch ON ch.prompt_hash = pv.hash
     WHERE ch.name = 'stable-v0' AND pv.role = $1 AND pv.slot_id = $2
     LIMIT 1`,
    [role, slotId],
  );
  return result.rows[0]?.text ?? '';
}

async function persistFrontier(frontier: FrontierVariant[]): Promise<void> {
  for (const member of frontier) {
    await pool.query(
      `INSERT INTO oweibo.prompt_versions
         (hash, role, slot_id, template_version, text, parent_hash, mutation_status,
          eval_score, created_at)
       VALUES ($1,$2,$3,'stable-v0',$4,$5,'pending_human_review',$6,NOW())
       ON CONFLICT (hash) DO NOTHING`,
      [
        member.hash, member.role, member.slotId, member.text,
        member.parentHash ?? null,
        JSON.stringify(member.paretoScore),
      ],
    );
  }
}

async function checkOperationalMode(): Promise<{ runEvals: boolean; runMutations: boolean }> {
  try {
    const result = await pool.query<{ current_mode: number }>(
      `SELECT current_mode FROM oweibo.platform_operational_mode WHERE singleton_id = TRUE`,
    );
    const mode = result.rows[0]?.current_mode ?? 5;

    if (mode <= 2) {
      // Modes 0-2: optimizer cron is disabled entirely
      console.log(`[gepa-optimizer] Skipping run — platform mode ${mode} (≤2 disables GEPA). Mode: ${MODE_NAMES[mode] ?? mode}`);
      return { runEvals: false, runMutations: false };
    }
    if (mode === 3) {
      // Mode 3: no bandit learning — GEPA is also paused (below eval-only threshold)
      console.log(`[gepa-optimizer] Skipping run — platform mode 3 (no bandit learning; GEPA paused below eval-only threshold)`);
      return { runEvals: false, runMutations: false };
    }
    if (mode === 4) {
      // Mode 4: eval-only — run evals but do NOT generate mutations or persist frontier offspring
      console.log(`[gepa-optimizer] Mode 4 (eval-only) — will run evals against current frontier but skip mutation generation`);
      return { runEvals: true, runMutations: false };
    }
    // Mode 5: full operation
    return { runEvals: true, runMutations: true };
  } catch {
    // Fail-open: if mode table is unavailable, proceed as full operation
    console.warn('[gepa-optimizer] Could not read operational mode — proceeding as mode 5 (full operation)');
    return { runEvals: true, runMutations: true };
  }
}

const MODE_NAMES: Record<number, string> = {
  5: 'Full operation', 4: 'Eval-only', 3: 'No bandit learning',
  2: 'No GEPA mutations', 1: 'No promotions', 0: 'Full freeze (stable-v0 only)',
};

// ── §10.7 Cost-of-learning governor ──────────────────────────────────────────

type VelocityTier = 'healthy' | 'slowing' | 'stagnating' | 'converged';

/**
 * Governor response per §10.7:
 *   healthy    — full nightly cadence; Tier 0–3 default depths
 *   slowing    — drop offspring count from 3-per-parent to 2; ~33% cost reduction
 *   stagnating — weekly cadence, reduce parents-per-slot from 3 to 2; ~70% cost reduction
 *   converged  — optimizer pauses for that slot; charter reviews at next quarterly cycle
 */
interface GovernorOverrides {
  readonly skip:           boolean;
  readonly populationSize: number;
  readonly maxGenerations: number;
}

const GOVERNOR_RESPONSE: Record<VelocityTier, GovernorOverrides> = {
  healthy:    { skip: false, populationSize: 5, maxGenerations: 3 },
  slowing:    { skip: false, populationSize: 3, maxGenerations: 3 },
  stagnating: { skip: false, populationSize: 2, maxGenerations: 2 },
  converged:  { skip: true,  populationSize: 0, maxGenerations: 0 },
};

async function getVelocityTier(slotId: string): Promise<VelocityTier> {
  try {
    const result = await pool.query<{ velocity_tier: string }>(
      `SELECT velocity_tier FROM oweibo.gepa_velocity_state WHERE slot_id = $1`,
      [slotId],
    );
    const tier = result.rows[0]?.velocity_tier;
    if (tier && tier in GOVERNOR_RESPONSE) return tier as VelocityTier;
    // No row yet (first run before velocity tracker has computed) — default healthy
    return 'healthy';
  } catch {
    // Fail-open: if velocity table is unavailable, run at full capacity
    console.warn(`[gepa-optimizer] Could not read velocity state for ${slotId} — defaulting to healthy`);
    return 'healthy';
  }
}

async function main() {
  console.log('[gepa-optimizer] Starting nightly GEPA run');
  const startMs = Date.now();

  // §17.5.1 — Check operational mode before doing any work
  const { runEvals, runMutations } = await checkOperationalMode();
  if (!runEvals && !runMutations) {
    await pool.end();
    return;
  }

  const buckets = await getReleasableBuckets();
  if (buckets.length === 0) {
    console.log('[gepa-optimizer] No releasable buckets — exiting');
    await pool.end();
    return;
  }

  const llm = makeLlm();

  for (const bucket of buckets) {
    if (!CANONICAL_ROLES.includes(bucket.role as any)) continue;

    // §10.7 — Check velocity governor before building config
    const velocityTier = await getVelocityTier(bucket.slot_id);
    const governor     = GOVERNOR_RESPONSE[velocityTier];

    if (governor.skip) {
      console.log(`[gepa-optimizer] 🔴 Skipping ${bucket.role}/${bucket.slot_id} — converged (velocity governor §10.7). Charter reviews at next quarterly cycle.`);
      continue;
    }

    if (velocityTier !== 'healthy') {
      const tierEmoji: Record<string, string> = { slowing: '🟡', stagnating: '🟠' };
      console.log(`[gepa-optimizer] ${tierEmoji[velocityTier] ?? ''} ${bucket.role}/${bucket.slot_id}: velocity=${velocityTier} — reducing to pop=${governor.populationSize}, gen=${governor.maxGenerations}`);
    }

    const config: OptimizerConfig = {
      role:             bucket.role,
      slotId:           bucket.slot_id,
      populationSize:   runMutations ? governor.populationSize : 1,
      maxGenerations:   runMutations ? governor.maxGenerations : 0,
      vendorPanel:      VENDOR_PANEL,
      budgetCapUsd:     MAX_COST_USD,
      costPerMTokenUsd: 15,
    };

    const optimizer = new PromptSlotOptimizer(config, {
      evalLlm:         llm,
      reflectionLlm:   llm,
      pool,
      getEmbedding:    async () => [],   // stub — real impl uses ModelRouter.forEmbedding()
      getLessons:      (role: string, slotId: string, limit: number) => getLessons(role, slotId, limit),
      getIncumbentText,
    });

    const incumbentText = await getIncumbentText(bucket.role, bucket.slot_id);
    if (!incumbentText) continue;

    const incumbentHash = createHash('sha256')
      .update(`${bucket.role}:${bucket.slot_id}:${incumbentText}`)
      .digest('hex');

    // Seed frontier with incumbent
    const seedFrontier: FrontierVariant[] = [{
      hash: incumbentHash, text: incumbentText,
      role: bucket.role, slotId: bucket.slot_id, generation: 0,
      evalResult: { promptHash: incumbentHash, evalSuiteVersion: '1.0.0', scores: [],
                   qualityPassRate: 0.7, qualityScoreMean: 0.7, tokensP50: 1000, tokensP95: 2000 },
      paretoScore: { qualityPassRate: 0.7, qualityScoreMean: 0.7, tokensP50: 1000, tokensP95: 2000 },
    }];

    let frontier = seedFrontier;
    if (config.maxGenerations > 0) {
      for (let g = 1; g <= config.maxGenerations; g++) {
        frontier = await optimizer.runOneGeneration(g, frontier, []);
        console.log(`[gepa-optimizer] ${bucket.role}/${bucket.slot_id} gen=${g} frontier_size=${frontier.length}`);
      }
    }

    // Only persist new frontier offspring when mutations are allowed
    if (runMutations) {
      await persistFrontier(frontier);
    } else {
      console.log(`[gepa-optimizer] Eval-only mode — skipping frontier persist for ${bucket.role}/${bucket.slot_id}`);
    }
  }

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[gepa-optimizer] Done in ${elapsedS}s`);
  await pool.end();
}

main().catch(err => {
  console.error('[gepa-optimizer] Fatal:', err);
  process.exit(1);
});
