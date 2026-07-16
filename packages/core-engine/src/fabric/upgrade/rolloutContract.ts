/**
 * K.9 / ADR-004 §3.7 — connector software upgrade rollout, the pure rules.
 *
 * Three properties this module makes structural (armed at K.9; specified since
 * ADR-004 ratification):
 *
 *  1. BLUE/GREEN — in-flight work never crosses versions. A job is tagged with
 *     the connector version that must process it; a worker at a different
 *     version MUST NOT claim it. A stale worker cannot pick up work minted for
 *     the new version, and vice versa (INV-8 spirit at the job level, on top of
 *     the kf_leases fencing that guards the exclusive upgrade operation itself).
 *
 *  2. CANARY-BY-COHORT — a new version reaches only the canary cohort's tenants
 *     first (reusing the shipped tenant-cohort model). A tenant outside the
 *     cohort keeps processing at the active version until promotion.
 *
 *  3. ROLLBACK — re-tags QUEUED jobs to the prior version. Jobs already leased
 *     are left to finish under their minted version (that is the point of
 *     blue/green: a rollback never yanks work out from under a running worker).
 */

export type RolloutState = 'stable' | 'canary' | 'rolling_back';

export interface ConnectorDeployment {
  readonly tenantId: string;
  readonly connectorId: string;
  /** The version currently serving this tenant's connector. */
  readonly activeVersion: string;
  /** The version being rolled toward, when a canary/rollback is in flight. */
  readonly targetVersion?: string;
  readonly state: RolloutState;
  /** The cohort channel this tenant belongs to (from the shipped cohort model). */
  readonly tenantCohort: string;
  /** The cohort a canary is scoped to; a tenant is in the canary iff it matches. */
  readonly canaryCohort?: string;
}

/**
 * The version a NEW job for this deployment must be tagged with — the version
 * whose worker should process it.
 *
 * During a canary, a tenant IN the canary cohort mints jobs at the target
 * version; a tenant outside it stays on the active version. A rollback mints at
 * the active (prior) version regardless. Outside a rollout, always the active
 * version.
 */
export function effectiveJobVersion(d: ConnectorDeployment): string {
  if (d.state === 'canary' && d.targetVersion && d.canaryCohort && d.tenantCohort === d.canaryCohort) {
    return d.targetVersion;
  }
  // stable, rolling_back, or a canary this tenant is not part of.
  return d.activeVersion;
}

/**
 * BLUE/GREEN claim rule: a worker at `workerVersion` may claim a job tagged
 * `jobVersion` iff they match. A NULL/undefined job tag is legacy (pre-upgrade
 * jobs minted before version tagging existed) and any worker may process it —
 * the additive-column migration must not strand already-queued work.
 */
export function workerCanClaim(jobVersion: string | null | undefined, workerVersion: string): boolean {
  if (jobVersion === null || jobVersion === undefined) return true; // legacy untagged
  return jobVersion === workerVersion;
}

/** §3.7 — is this tenant part of the given canary? */
export function tenantInCanary(d: Pick<ConnectorDeployment, 'tenantCohort'>, canaryCohort: string): boolean {
  return d.tenantCohort === canaryCohort;
}

export interface QueuedJobTag {
  readonly jobId: string;
  readonly state: string;
  readonly connectorVersion: string | null;
}

/**
 * ROLLBACK re-tag selection: of the given jobs, which get re-tagged to
 * `priorVersion`. ONLY queued jobs currently tagged at the (rolled-back) target
 * version. Leased/succeeded/failed jobs are untouched — a leased job finishes
 * under the version it was minted for (blue/green), and terminal jobs are done.
 */
export function jobsToRetagOnRollback(
  jobs: readonly QueuedJobTag[],
  targetVersion: string,
  priorVersion: string,
): readonly string[] {
  if (targetVersion === priorVersion) return [];
  return jobs
    .filter((j) => j.state === 'queued' && j.connectorVersion === targetVersion)
    .map((j) => j.jobId);
}

/**
 * A rollout transition guard — the legal deployment-state moves (§3.7). A canary
 * promotes to stable (target becomes active) or rolls back; a rollback returns
 * to stable. There is no canary→canary re-target without first resolving.
 */
export function isLegalRolloutTransition(from: RolloutState, to: RolloutState): boolean {
  const legal: Record<RolloutState, readonly RolloutState[]> = {
    stable: ['canary'],
    canary: ['stable', 'rolling_back'],
    rolling_back: ['stable'],
  };
  return legal[from].includes(to);
}
