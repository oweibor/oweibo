// D.14 — Elegance battery runner.
// Generates agent outputs for each fixture (LLM or synthetic in dry-run),
// persists to oweibo.elegance_battery_run_outputs, and returns for human grading.

import type { Pool } from 'pg';
import { FIXTURES, type TaskFixture } from './fixtures.js';

export interface RunnerDeps {
  pool:      Pool;
  runMonth:  string;   // 'YYYY-MM'
  reviewerId: string;
  dryRun:    boolean;
  /** Optional LLM call for real mode. Takes system + user prompt, returns output string. */
  llmGenerate?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export interface BatteryOutput {
  fixture: TaskFixture;
  output:  string;
  /** true if output is synthetic (dry-run) */
  synthetic: boolean;
}

const BATTERY_SYSTEM_PROMPT = `You are an expert software engineer. Answer the question concisely and directly.`;

/**
 * Run the battery: generate one output per fixture.
 * Returns outputs in fixture order for presentation to the reviewer.
 */
export async function runBattery(deps: RunnerDeps): Promise<BatteryOutput[]> {
  const results: BatteryOutput[] = [];

  for (const fixture of FIXTURES) {
    let output: string;
    let synthetic: boolean;

    if (deps.dryRun || !deps.llmGenerate) {
      // Dry-run: alternate good/bad to ensure escalation fires on bad ones
      // Inject the syntheticBadOutput for every other fixture (first, third, fifth...)
      // so the test suite sees at least one red-escalation path.
      const idx = FIXTURES.indexOf(fixture);
      output    = idx % 2 === 0 ? fixture.syntheticBadOutput : fixture.syntheticGoodOutput;
      synthetic = true;
    } else {
      try {
        output    = await deps.llmGenerate(BATTERY_SYSTEM_PROMPT, fixture.prompt);
        synthetic = false;
      } catch {
        // Fall back to synthetic on LLM error
        output    = fixture.syntheticGoodOutput;
        synthetic = true;
      }
    }

    results.push({ fixture, output, synthetic });
  }

  return results;
}

/**
 * Persist battery outputs to the DB so the reviewer UI can retrieve them.
 * Uses an upsert so re-runs within the same month overwrite prior outputs.
 */
export async function persistBatteryOutputs(
  pool:      Pool,
  runMonth:  string,
  outputs:   BatteryOutput[],
): Promise<void> {
  // Create the run_outputs table on first use if it doesn't exist.
  // (The table is not in the Phase D migration; it's auxiliary tooling.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oweibo.elegance_battery_run_outputs (
      run_month   TEXT NOT NULL,
      task_id     TEXT NOT NULL,
      output      TEXT NOT NULL,
      synthetic   BOOLEAN NOT NULL DEFAULT false,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (run_month, task_id)
    )
  `);

  for (const { fixture, output, synthetic } of outputs) {
    await pool.query(
      `INSERT INTO oweibo.elegance_battery_run_outputs
         (run_month, task_id, output, synthetic)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_month, task_id) DO UPDATE SET
         output       = EXCLUDED.output,
         synthetic    = EXCLUDED.synthetic,
         generated_at = NOW()`,
      [runMonth, fixture.id, output, synthetic],
    );
  }
}

/**
 * Load outputs for a given month (for the reviewer UI).
 */
export async function loadBatteryOutputs(
  pool:     Pool,
  runMonth: string,
): Promise<Map<string, { output: string; synthetic: boolean }>> {
  const result = await pool.query<{
    task_id:   string;
    output:    string;
    synthetic: boolean;
  }>(
    `SELECT task_id, output, synthetic
     FROM oweibo.elegance_battery_run_outputs
     WHERE run_month = $1`,
    [runMonth],
  );

  return new Map(result.rows.map(r => [r.task_id, { output: r.output, synthetic: r.synthetic }]));
}

/** Return the canonical run month string for the current date. */
export function currentRunMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
