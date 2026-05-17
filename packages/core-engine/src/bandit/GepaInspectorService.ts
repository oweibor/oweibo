// C.8 — GepaInspectorService: read-only observability for the GEPA optimizer.
//
// Surfaces for the admin-web /(platform)/prompts page:
//   - listRuns()       — recent nightly gepa_runs (cost, status, candidates)
//   - listCandidates() — recent prompt_versions, filterable by role/slot
//   - slotFrontier()   — all candidates for one (slot,role) ranked by eval_score
//   - costSeries()     — daily cost totals over a rolling window
//   - velocityTiers()  — per-slot gepa_velocity_state

import type { Pool } from 'pg';

export interface GepaRun {
  id:                  string;
  runDate:             string;
  status:              'running' | 'completed' | 'failed' | 'budget_exceeded';
  slotsProcessed:      number;
  candidatesGenerated: number;
  frontierSize:        number;
  costUsd:             number;
  startedAt:           string;
  completedAt:         string | null;
  error:               string | null;
}

export interface CandidateRow {
  hash:           string;
  role:           string;
  slotId:         string;
  templateVersion: string;
  parentHash:     string | null;
  mutationStatus: string;
  evalScore:      Record<string, unknown> | null;
  createdAt:      string;
  updatedBy:      string | null;
  textPreview:    string;
}

export interface CostPoint {
  day:     string;
  costUsd: number;
  runs:    number;
}

export interface VelocityRow {
  slotId:        string;
  velocityTier:  'healthy' | 'slowing' | 'stagnating' | 'converged';
  delta7d:       number;
  deltaBaseline: number;
  computedAt:    string;
}

export class GepaInspectorService {
  constructor(private readonly pool: Pool) {}

  async listRuns(limit = 14): Promise<GepaRun[]> {
    const res = await this.pool.query<{
      id: string; run_date: string; status: string;
      slots_processed: number; candidates_generated: number; frontier_size: number;
      cost_usd: string; started_at: string; completed_at: string | null; error: string | null;
    }>(
      `SELECT id, run_date, status, slots_processed, candidates_generated,
              frontier_size, cost_usd, started_at, completed_at, error
       FROM oweibo.gepa_runs
       ORDER BY run_date DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map(r => ({
      id:                  r.id,
      runDate:             r.run_date,
      status:              r.status as GepaRun['status'],
      slotsProcessed:      r.slots_processed,
      candidatesGenerated: r.candidates_generated,
      frontierSize:        r.frontier_size,
      costUsd:             parseFloat(r.cost_usd),
      startedAt:           r.started_at,
      completedAt:         r.completed_at,
      error:               r.error,
    }));
  }

  async listCandidates(filter?: {
    role?:   string;
    slotId?: string;
    limit?:  number;
  }): Promise<CandidateRow[]> {
    const conditions: string[] = [];
    const params:     unknown[] = [];
    if (filter?.role)   { conditions.push(`role = $${params.length + 1}`);    params.push(filter.role); }
    if (filter?.slotId) { conditions.push(`slot_id = $${params.length + 1}`); params.push(filter.slotId); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(filter?.limit ?? 50);

    const res = await this.pool.query<{
      hash: string; role: string; slot_id: string; template_version: string;
      parent_hash: string | null; mutation_status: string; eval_score: Record<string, unknown> | null;
      created_at: string; updated_by: string | null; text: string;
    }>(
      `SELECT hash, role, slot_id, template_version, parent_hash, mutation_status,
              eval_score, created_at, updated_by, text
       FROM oweibo.prompt_versions
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(r => ({
      hash:            r.hash,
      role:            r.role,
      slotId:          r.slot_id,
      templateVersion: r.template_version,
      parentHash:      r.parent_hash,
      mutationStatus:  r.mutation_status,
      evalScore:       r.eval_score,
      createdAt:       r.created_at,
      updatedBy:       r.updated_by,
      textPreview:     r.text.slice(0, 200),
    }));
  }

  /**
   * All candidates for one (slot, role), ranked by best eval_score axis.
   * Indicates which one is live on each channel pointer.
   */
  async slotFrontier(slotId: string, role: string): Promise<{
    candidates: Array<CandidateRow & { liveOnChannels: string[]; banditAlpha?: number; banditBeta?: number }>;
    channels:   Array<{ name: string; promptHash: string; version: string }>;
  }> {
    const [candidatesRes, channelsRes, armsRes] = await Promise.all([
      this.pool.query<{
        hash: string; role: string; slot_id: string; template_version: string;
        parent_hash: string | null; mutation_status: string; eval_score: Record<string, unknown> | null;
        created_at: string; updated_by: string | null; text: string;
      }>(
        `SELECT hash, role, slot_id, template_version, parent_hash, mutation_status,
                eval_score, created_at, updated_by, text
         FROM oweibo.prompt_versions
         WHERE slot_id = $1 AND role = $2
         ORDER BY created_at DESC`,
        [slotId, role],
      ),
      this.pool.query<{ name: string; prompt_hash: string; version: string }>(
        `SELECT name, prompt_hash, version::text
         FROM oweibo.channels
         WHERE slot_id = $1 AND role = $2
         ORDER BY name`,
        [slotId, role],
      ),
      this.pool.query<{ arm_id: string; alpha: string; beta: string }>(
        `SELECT arm_id, alpha::text, beta::text
         FROM oweibo.bandit_arms
         WHERE slot_id = $1 AND active = TRUE`,
        [slotId],
      ).catch(() => ({ rows: [] as Array<{ arm_id: string; alpha: string; beta: string }> })),
    ]);

    const armByHash = new Map(armsRes.rows.map(r => [r.arm_id, r]));
    const liveByHash = new Map<string, string[]>();
    for (const ch of channelsRes.rows) {
      const arr = liveByHash.get(ch.prompt_hash) ?? [];
      arr.push(ch.name);
      liveByHash.set(ch.prompt_hash, arr);
    }

    const candidates = candidatesRes.rows.map(r => {
      const arm = armByHash.get(r.hash);
      const base = {
        hash:            r.hash,
        role:            r.role,
        slotId:          r.slot_id,
        templateVersion: r.template_version,
        parentHash:      r.parent_hash,
        mutationStatus:  r.mutation_status,
        evalScore:       r.eval_score,
        createdAt:       r.created_at,
        updatedBy:       r.updated_by,
        textPreview:     r.text.slice(0, 400),
        liveOnChannels:  liveByHash.get(r.hash) ?? [],
      };
      return arm
        ? { ...base, banditAlpha: parseFloat(arm.alpha), banditBeta: parseFloat(arm.beta) }
        : base;
    });

    const channels = channelsRes.rows.map(c => ({
      name:       c.name,
      promptHash: c.prompt_hash,
      version:    c.version,
    }));

    return { candidates, channels };
  }

  async costSeries(days = 14): Promise<CostPoint[]> {
    const res = await this.pool.query<{ day: string; cost_usd: string; runs: string }>(
      `SELECT run_date::text AS day,
              SUM(cost_usd)::text AS cost_usd,
              COUNT(*)::text      AS runs
       FROM oweibo.gepa_runs
       WHERE run_date >= NOW()::date - ($1::int - 1)
       GROUP BY run_date
       ORDER BY run_date`,
      [days],
    );
    return res.rows.map(r => ({
      day:     r.day,
      costUsd: parseFloat(r.cost_usd),
      runs:    parseInt(r.runs, 10),
    }));
  }

  async velocityTiers(): Promise<VelocityRow[]> {
    const res = await this.pool.query<{
      slot_id: string; velocity_tier: string;
      delta_7d: string; delta_baseline: string; computed_at: string;
    }>(
      `SELECT slot_id, velocity_tier, delta_7d::text, delta_baseline::text, computed_at
       FROM oweibo.gepa_velocity_state
       ORDER BY slot_id`,
    ).catch(() => ({ rows: [] as Array<{
      slot_id: string; velocity_tier: string;
      delta_7d: string; delta_baseline: string; computed_at: string;
    }> }));
    return res.rows.map(r => ({
      slotId:        r.slot_id,
      velocityTier:  r.velocity_tier as VelocityRow['velocityTier'],
      delta7d:       parseFloat(r.delta_7d),
      deltaBaseline: parseFloat(r.delta_baseline),
      computedAt:    r.computed_at,
    }));
  }
}
