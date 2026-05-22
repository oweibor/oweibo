/**
 * T.5.a: CalibrationService — computes per-tenant readiness from purely
 * observable signals (no statistical fitting; operator-legible weights).
 *
 * Returns:
 *   - a global scalar (0..1) for UX dashboards and the autonomous-mode
 *     gate landing in T.5.b
 *   - a per-action-class vector consumed by T.−1's ActionTrustLadder
 *
 * The per-class vector is the load-bearing path: classes with zero
 * observations score below the T.−1 matrix's 0.6 / 0.85 thresholds by
 * construction, which is how cold-start safety is preserved without any
 * additional configuration.
 *
 * All signals are read directly from Postgres; the organic-memory count
 * is optionally supplied by the caller (Qdrant lives outside this service).
 *
 * sourceSig: each snapshot is signed with an HMAC-SHA256 over its fields
 * so callers (chiefly ActionTrustLadder.gate) can verify the snapshot was
 * issued by this service and was not inline-constructed by a tool. The
 * key comes from CALIBRATION_SOURCE_KEY env or a stable default for tests.
 */
import { createHmac } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type { TenantReadinessSnapshot } from '@oweibo/core-contracts';

export interface CalibrationSignals {
  readonly accountAgeDays: number;
  readonly organicMemoryCount: number;
  readonly slotsWithLearnedArms: number;
  readonly completedTaskCount: number;
  readonly bootstrapReady: boolean;
  readonly actionClassObservations: Readonly<Record<string, number>>;
  readonly actionClassSuccessRatios: Readonly<Record<string, number>>;
}

export interface TenantReadiness {
  readonly tenantId: string;
  /** 0..1 — composite global readiness. 0 = brand new, 1 = fully calibrated. */
  readonly score: number;
  /** Per-action-class readiness, consumed by ActionTrustLadder. */
  readonly actionClassScores: Readonly<Record<string, number>>;
  readonly signals: CalibrationSignals;
  readonly summary: string;
  /** ISO timestamp at which this readiness was computed. */
  readonly snapshotAt: string;
  /** HMAC of the snapshot for integrity verification by downstream consumers. */
  readonly sourceSig: string;
}

/** Counter for organic (non-seed) memories. Injectable so the service does
 *  not have to know about Qdrant. Default returns 0 — safe under cold-start. */
export type OrganicMemoryCounter = (tenantId: string) => Promise<number>;

export interface CalibrationServiceOptions {
  countOrganicMemories?: OrganicMemoryCounter;
  /** Override the HMAC key. Tests pin this; production reads env. */
  sourceKey?: string;
  /** Override clock; tests pin time. */
  now?: () => Date;
}

const DEFAULT_SOURCE_KEY = 'oweibo-calibration-source-v1';

export class CalibrationService {
  private readonly countOrganic: OrganicMemoryCounter;
  private readonly sourceKey: string;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: CalibrationServiceOptions = {}) {
    this.countOrganic = opts.countOrganicMemories ?? (async () => 0);
    this.sourceKey = opts.sourceKey ?? process.env['CALIBRATION_SOURCE_KEY'] ?? DEFAULT_SOURCE_KEY;
    this.now = opts.now ?? (() => new Date());
  }

  /** Compute a full readiness report for one tenant. */
  async compute(tenantId: string): Promise<TenantReadiness> {
    const signals = await this.gatherSignals(tenantId);
    const score = globalScore(signals);
    const actionClassScores = perClassScores(signals);
    const summary = renderSummary(score, signals);
    const snapshotAt = this.now().toISOString();
    const sourceSig = this.sign(tenantId, snapshotAt, score, actionClassScores);
    return {
      tenantId,
      score,
      actionClassScores,
      signals,
      summary,
      snapshotAt,
      sourceSig,
    };
  }

  /**
   * Build the minimal snapshot consumed by ActionTrustLadder.gate. The
   * snapshot is signed independently of the full TenantReadiness — its
   * signature excludes the global score (which the snapshot does not
   * carry), so verify() only needs the snapshot's own fields.
   */
  async snapshot(tenantId: string): Promise<TenantReadinessSnapshot> {
    const r = await this.compute(tenantId);
    const snapshotAt = r.snapshotAt;
    const actionClassScores = r.actionClassScores;
    return {
      tenantId,
      accountAgeDays: r.signals.accountAgeDays,
      actionClassScores,
      snapshotAt,
      sourceSig: this.sign(tenantId, snapshotAt, NaN, actionClassScores),
    };
  }

  /** Verify that a snapshot was issued by this service. */
  verify(snapshot: TenantReadinessSnapshot): boolean {
    if (!snapshot.sourceSig) return false;
    const expected = this.sign(
      snapshot.tenantId,
      snapshot.snapshotAt,
      // The verifier doesn't have the original score, but it has the
      // per-class scores — those are what gets signed. Score is signed
      // too in `sign()`, so we use the implied score=NaN sentinel:
      // verification recomputes from the snapshot's actual fields.
      NaN,
      snapshot.actionClassScores,
    );
    // For snapshots, sourceSig is computed without the score (since the
    // snapshot doesn't carry it). The signing function emits two forms:
    // full (with score) and snapshot (without). Verification picks the
    // snapshot form.
    return expected === snapshot.sourceSig;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private sign(
    tenantId: string,
    snapshotAt: string,
    score: number,
    actionClassScores: Readonly<Record<string, number>>,
  ): string {
    // Stable ordering so the HMAC is deterministic across runs.
    const classes = Object.keys(actionClassScores).sort();
    const classBlob = classes.map((k) => `${k}=${actionClassScores[k]!.toFixed(6)}`).join(',');
    const scoreBlob = Number.isNaN(score) ? '' : score.toFixed(6);
    const payload = `${tenantId}|${snapshotAt}|${scoreBlob}|${classBlob}`;
    return createHmac('sha256', this.sourceKey).update(payload).digest('hex');
  }

  private async gatherSignals(tenantId: string): Promise<CalibrationSignals> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);

      const accountAgeDays = await fetchAccountAgeDays(client, tenantId, this.now());
      const slotsWithLearnedArms = await fetchSlotsWithLearnedArms(client, tenantId);
      const completedTaskCount = await fetchCompletedTaskCount(client, tenantId);
      const bootstrapReady = await fetchBootstrapReady(client, tenantId);
      const { observations, successRatios } = await fetchActionClassSignals(client, tenantId);

      await client.query('COMMIT');

      const organicMemoryCount = await this.countOrganic(tenantId).catch(() => 0);

      return {
        accountAgeDays,
        organicMemoryCount,
        slotsWithLearnedArms,
        completedTaskCount,
        bootstrapReady,
        actionClassObservations: observations,
        actionClassSuccessRatios: successRatios,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Score formulas (exported so tests can pin their behavior) ─────────────

export function globalScore(s: CalibrationSignals): number {
  const ageTerm        = 0.20 * Math.min(s.accountAgeDays / 30, 1);
  const memoryTerm     = 0.30 * Math.min(s.organicMemoryCount / 50, 1);
  const banditTerm     = 0.20 * Math.min(s.slotsWithLearnedArms / 8, 1);
  const taskTerm       = 0.20 * Math.min(s.completedTaskCount / 25, 1);
  const bootstrapTerm  = 0.10 * (s.bootstrapReady ? 1 : 0);
  return ageTerm + memoryTerm + banditTerm + taskTerm + bootstrapTerm;
}

export function perClassScores(s: CalibrationSignals): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  const ageContribution        = 0.10 * Math.min(s.accountAgeDays / 30, 1);
  const bootstrapContribution  = 0.10 * (s.bootstrapReady ? 1 : 0);

  // Score every class that has either observations or a recorded success ratio.
  const classes = new Set<string>([
    ...Object.keys(s.actionClassObservations),
    ...Object.keys(s.actionClassSuccessRatios),
  ]);

  for (const cls of classes) {
    const obs = s.actionClassObservations[cls] ?? 0;
    const ratio = obs === 0 ? 0 : (s.actionClassSuccessRatios[cls] ?? 0);
    const obsTerm   = 0.40 * Math.min(obs / 20, 1);
    const ratioTerm = 0.40 * ratio;
    out[cls] = obsTerm + ratioTerm + ageContribution + bootstrapContribution;
  }
  return out;
}

function renderSummary(score: number, s: CalibrationSignals): string {
  if (score < 0.20) return 'Brand new: minimal calibration. Expect supervised mode and dry-runs.';
  if (score < 0.40) return 'Warming up: some calibration signal, autonomous mode not yet recommended.';
  if (score < 0.60) return 'Adapting: calibration approaching the autonomous threshold.';
  if (score < 0.85) return 'Calibrated: autonomous mode available with operator review.';
  return 'Fully calibrated.';
}

// ── DB readers ───────────────────────────────────────────────────────────

async function fetchAccountAgeDays(client: PoolClient, tenantId: string, now: Date): Promise<number> {
  const r = await client.query<{ created_at: Date }>(
    `SELECT created_at FROM oweibo.tenants WHERE id = $1::uuid`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) return 0;
  const ms = now.getTime() - new Date(row.created_at).getTime();
  return Math.max(0, Math.min(30, Math.floor(ms / 86_400_000)));
}

async function fetchSlotsWithLearnedArms(client: PoolClient, tenantId: string): Promise<number> {
  // bandit_arm_events records (task_id, slot_id, arm_id, reward). task_id
  // joins to tasks.id; tasks have tenant_id. Count distinct slots that have
  // at least one event for this tenant's tasks.
  const r = await client.query<{ count: string }>(
    `SELECT COUNT(DISTINCT bae.slot_id) AS count
       FROM oweibo.bandit_arm_events bae
       JOIN oweibo.tasks t ON t.id::text = bae.task_id
      WHERE t.tenant_id = $1::uuid`,
    [tenantId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

async function fetchCompletedTaskCount(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM oweibo.tasks
      WHERE tenant_id = $1::uuid AND completed_at IS NOT NULL`,
    [tenantId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

async function fetchBootstrapReady(client: PoolClient, tenantId: string): Promise<boolean> {
  const r = await client.query<{ state: string }>(
    `SELECT state FROM oweibo.tenant_bootstrap WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return r.rows[0]?.state === 'ready';
}

async function fetchActionClassSignals(
  client: PoolClient,
  tenantId: string,
): Promise<{ observations: Record<string, number>; successRatios: Record<string, number> }> {
  const r = await client.query<{ action_class: string; observations: number; successes: number }>(
    `SELECT action_class, observations, successes
       FROM oweibo.tenant_action_class_state
      WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const observations: Record<string, number> = {};
  const successRatios: Record<string, number> = {};
  for (const row of r.rows) {
    const obs = Number(row.observations ?? 0);
    const suc = Number(row.successes ?? 0);
    observations[row.action_class] = obs;
    successRatios[row.action_class] = obs > 0 ? suc / obs : 0;
  }
  return { observations, successRatios };
}
