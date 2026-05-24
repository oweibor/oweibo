/**
 * S.7 (ttv-action-safety-v2): forensic packet + replay contracts.
 *
 * A `ForensicPacket` is the full audit-grade snapshot of a single
 * action plan: the goal that produced it, every agent decision, every
 * gate decision, every adapter call, every verifier result, every
 * rollback. Suitable for delivery to legal counsel, compliance
 * auditors, or internal incident review.
 *
 * Packets are stored in object storage (S3 / MinIO), encrypted at
 * rest, signed at build time with HMAC-SHA256, with a row in
 * oweibo.forensic_packets keyed by storage ref + signature.
 *
 * Replay is a separate concern: an ActionReplayRun re-walks a plan's
 * decision chain *without* invoking real adapter execute() — only
 * preflight + verifier paths. Three replay kinds:
 *   * shadow_full — re-run every step in shadow mode
 *   * shadow_step — re-run a single step
 *   * what_if     — re-run with a single parameter mutated
 */

// ── Packet shape ─────────────────────────────────────────────────────────

export type ForensicTriggerKind =
  | 'manual'
  | 'auto_drift'
  | 'auto_rollback_failed'
  | 'auto_pattern'
  | 'compliance_request';

export type ForensicPacketState = 'open' | 'under_review' | 'resolved' | 'archived';

export type ForensicResolution =
  | 'resumed'
  | 'overridden'
  | 'aborted'
  | 'lessons_learned';

/**
 * Snapshot of an action_proposals row at the moment the packet was
 * built. The full row may have moved on since (state transitions, etc.);
 * the snapshot is the authoritative state for forensic review.
 */
export interface ActionProposalSnapshot {
  readonly proposalId: string;
  readonly actionClass: string;
  readonly actionId: string;
  readonly mode: 'dry_run' | 'shadow' | 'require_approval';
  readonly state: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly rollbackKind: string | null;
  readonly grantId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

export interface ExecutionRecord {
  readonly proposalId: string;
  readonly actionClass: string;
  readonly outcome: 'success' | 'failure';
  readonly executedAt: string;
}

export interface VerificationRecord {
  readonly proposalId: string;
  readonly verifierName: string;
  readonly timing: 'immediate' | 'deferred';
  readonly driftSeverity: 0 | 1 | 2 | 3;
  readonly expected: unknown;
  readonly observed: unknown;
  readonly verifiedAt: string;
}

export interface RollbackRecord {
  readonly originalActionId: string;
  readonly adapterName: string;
  readonly reason: string;
  readonly resultState: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface InspectionRecord {
  readonly proposalId: string | null;
  readonly inspectorName: string;
  readonly verdict: 'allow' | 'upgrade_to_approval' | 'forbid';
  readonly reason: string | null;
  readonly inspectedAt: string;
}

/**
 * The packet itself. Serialized to JSON (then optionally gzipped),
 * signed, and uploaded to object storage. The forensic_packets row
 * carries only the metadata (storage_ref + signature + state).
 */
export interface ForensicPacket {
  readonly packetId: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly summary: string;
  readonly triggerKind: ForensicTriggerKind;
  readonly triggeredBy: string;
  readonly originalGoal: string;
  readonly proposals: readonly ActionProposalSnapshot[];
  readonly executions: readonly ExecutionRecord[];
  readonly verifications: readonly VerificationRecord[];
  readonly rollbacks: readonly RollbackRecord[];
  readonly inspections: readonly InspectionRecord[];
  /** Free-form structured context — current schema includes calibration + bandit snapshots. */
  readonly contextSnapshots: Readonly<Record<string, unknown>>;
  readonly suggestedActions: readonly string[];
  /** UNIX epoch ms when the packet was built. */
  readonly builtAtMs: number;
  /** Schema version of this packet structure; advance on breaking changes. */
  readonly schemaVersion: number;
}

export const FORENSIC_PACKET_SCHEMA_VERSION = 1;

// ── Replay ───────────────────────────────────────────────────────────────

export type ReplayKind = 'shadow_full' | 'shadow_step' | 'what_if';

export type ReplayStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface ReplayMutation {
  /** Dot-path into the gate input or payload, e.g. 'orgGraph.approverCount'. */
  readonly path: string;
  readonly newValue: unknown;
}

export interface ReplayRequest {
  readonly tenantId: string;
  readonly planId: string;
  readonly requestedByUserId: string;
  readonly kind: ReplayKind;
  readonly mutation?: ReplayMutation;
  /** For shadow_step: which proposal id to single-step. */
  readonly proposalId?: string;
}

export interface ReplayStepResult {
  readonly proposalId: string;
  readonly actionClass: string;
  readonly originalDecision: string;
  readonly replayedDecision: string;
  readonly matches: boolean;
  readonly notes?: string;
}

export interface ReplayResult {
  readonly runId: string;
  readonly status: 'complete' | 'failed';
  readonly stepResults: readonly ReplayStepResult[];
  readonly totalSteps: number;
  readonly matchingSteps: number;
  readonly mismatchSteps: number;
  readonly failureReason?: string;
}

// ── Pluggable seams ──────────────────────────────────────────────────────

/**
 * Pluggable object-store interface used by the packet builder. The
 * production implementation wraps S3 / MinIO; tests inject an in-memory
 * shim. Storage MUST be append-only — packets are never overwritten.
 */
export interface IForensicPacketStorage {
  /** Returns the storage ref (e.g. S3 key) the packet was written to. */
  put(args: {
    readonly tenantId: string;
    readonly packetId: string;
    readonly bytes: Buffer;
  }): Promise<{ storageRef: string }>;
  get(storageRef: string): Promise<Buffer>;
}

/**
 * HMAC signer. The default implementation uses createHmac('sha256');
 * tests may inject a deterministic stub. The secret resolution is
 * implementation-specific (env var, KMS, etc.).
 */
export interface IPacketSigner {
  sign(bytes: Buffer): Promise<string>;
  verify(bytes: Buffer, signature: string): Promise<boolean>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Severity → trigger-kind for auto-fire HITL handoffs. Returns null if
 * the severity doesn't warrant an automatic packet.
 */
export function severityToAutoTrigger(severity: 0 | 1 | 2 | 3): ForensicTriggerKind | null {
  if (severity < 3) return null;
  return 'auto_drift';
}
