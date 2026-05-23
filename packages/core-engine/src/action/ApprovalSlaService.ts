/**
 * S.1: ApprovalSlaService — attach SLA state to a require_approval
 * proposal at create-time and update it as the lifecycle worker
 * progresses through escalation stages.
 *
 * Policy resolution order:
 *   1. tenant + actionClass exact match
 *   2. tenant + '*' default
 *   3. PLATFORM_DEFAULT_POLICY (computed from the matrix below)
 *
 * The default matrix mirrors the table in ttv-action-safety-v2.md S.1.
 * Each entry is a pure function of (actionClass) → policy fields. Tenants
 * can override via approval_sla_policies rows.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  ApprovalSlaPolicy,
  ApproverResolutionKind,
  NotificationChannelRef,
} from '@oweibo/core-contracts';

// ── Default policy matrix ─────────────────────────────────────────────────

interface DefaultPolicy {
  initialNotifyAfterSeconds: number;
  escalateAfterSeconds: readonly number[];
  hardExpireAfterSeconds: number;
  approverResolution: ApproverResolutionKind;
  approverConfig: unknown;
}

const MIN  = 60;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

/**
 * Class prefix → default policy. Most specific match wins (longer prefix).
 * Falls through to '*' default when nothing matches.
 */
const DEFAULT_MATRIX: ReadonlyArray<{ prefix: string; policy: DefaultPolicy }> = [
  { prefix: 'financial.',          policy: { initialNotifyAfterSeconds: 0,       escalateAfterSeconds: [15*MIN, HOUR, 4*HOUR],  hardExpireAfterSeconds: 48*HOUR, approverResolution: 'org_graph', approverConfig: { chain: 'cfo' } } },
  { prefix: 'personnel.',          policy: { initialNotifyAfterSeconds: 0,       escalateAfterSeconds: [30*MIN, 4*HOUR, 24*HOUR], hardExpireAfterSeconds: 72*HOUR, approverResolution: 'org_graph', approverConfig: { chain: 'hr' } } },
  { prefix: 'irreversible.',       policy: { initialNotifyAfterSeconds: 0,       escalateAfterSeconds: [30*MIN, HOUR, 4*HOUR],  hardExpireAfterSeconds: 24*HOUR, approverResolution: 'org_graph', approverConfig: {} } },
  { prefix: 'deploy.prod',         policy: { initialNotifyAfterSeconds: 5*MIN,   escalateAfterSeconds: [30*MIN, 2*HOUR],         hardExpireAfterSeconds: 8*HOUR,  approverResolution: 'org_graph', approverConfig: { chain: 'eng_mgr_plus_one' } } },
  { prefix: 'comm.external_',      policy: { initialNotifyAfterSeconds: 5*MIN,   escalateAfterSeconds: [30*MIN, 2*HOUR, 6*HOUR],  hardExpireAfterSeconds: 24*HOUR, approverResolution: 'org_graph', approverConfig: { domain: 'communications' } } },
  { prefix: 'write.external_api.prod', policy: { initialNotifyAfterSeconds: 5*MIN, escalateAfterSeconds: [30*MIN, 2*HOUR, 6*HOUR], hardExpireAfterSeconds: 24*HOUR, approverResolution: 'org_graph', approverConfig: { domain: 'system_owner' } } },
  { prefix: 'write.tenant_db.prod', policy: { initialNotifyAfterSeconds: 60,    escalateAfterSeconds: [15*MIN, HOUR],            hardExpireAfterSeconds: 4*HOUR,  approverResolution: 'org_graph', approverConfig: { domain: 'data_owner' } } },
];

const FALLBACK_DEFAULT: DefaultPolicy = {
  initialNotifyAfterSeconds: 30 * MIN,
  escalateAfterSeconds: [4 * HOUR, 24 * HOUR],
  hardExpireAfterSeconds: 7 * DAY,
  approverResolution: 'role_based',
  approverConfig: { roles: ['tenant_admin'] },
};

const DEFAULT_NOTIFICATION_CHANNELS: readonly NotificationChannelRef[] = [
  { channelKind: 'in_app', config: {}, fireOn: ['initial', 'escalation', 'expiry', 'decision'] },
];

export function platformDefaultPolicy(
  tenantId: string,
  actionClass: string,
): ApprovalSlaPolicy {
  // Most-specific (longest) matching prefix wins.
  let match: DefaultPolicy = FALLBACK_DEFAULT;
  let matchLen = 0;
  for (const entry of DEFAULT_MATRIX) {
    if (actionClass.startsWith(entry.prefix) && entry.prefix.length > matchLen) {
      match = entry.policy;
      matchLen = entry.prefix.length;
    }
  }
  return {
    tenantId,
    actionClass,
    initialNotifyAfterSeconds: match.initialNotifyAfterSeconds,
    escalateAfterSeconds: match.escalateAfterSeconds,
    hardExpireAfterSeconds: match.hardExpireAfterSeconds,
    approverResolution: match.approverResolution,
    approverConfig: match.approverConfig,
    notificationChannels: DEFAULT_NOTIFICATION_CHANNELS,
  };
}

// ── Service ────────────────────────────────────────────────────────────────

export interface ApprovalSlaServiceOptions {
  isEnabled?: () => boolean;
  now?: () => Date;
}

export class ApprovalSlaService {
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: ApprovalSlaServiceOptions = {}) {
    this.isEnabled = opts.isEnabled ?? defaultEnabled;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Resolve the effective policy for (tenantId, actionClass). Reads the
   * exact-class row first, then the '*' default row, then falls back to
   * the platform matrix. Pure DB read; safe to call on every gate decision.
   */
  async resolvePolicy(tenantId: string, actionClass: string): Promise<ApprovalSlaPolicy> {
    return this.tx(tenantId, async (client) => {
      const rows = await client.query<{
        id: string;
        action_class: string;
        initial_notify_after_seconds: number;
        escalate_after_seconds: number[];
        hard_expire_after_seconds: number;
        approver_resolution: string;
        approver_config: unknown;
        notification_channels: unknown;
        quiet_hours: unknown;
      }>(
        `SELECT id, action_class, initial_notify_after_seconds, escalate_after_seconds,
                hard_expire_after_seconds, approver_resolution, approver_config,
                notification_channels, quiet_hours
           FROM oweibo.approval_sla_policies
          WHERE tenant_id = $1::uuid AND action_class IN ($2, '*')
          ORDER BY (action_class = $2) DESC
          LIMIT 1`,
        [tenantId, actionClass],
      );
      const row = rows.rows[0];
      if (!row) return platformDefaultPolicy(tenantId, actionClass);
      return {
        tenantId,
        actionClass: row.action_class,
        initialNotifyAfterSeconds: row.initial_notify_after_seconds,
        escalateAfterSeconds: row.escalate_after_seconds,
        hardExpireAfterSeconds: row.hard_expire_after_seconds,
        approverResolution: row.approver_resolution as ApproverResolutionKind,
        approverConfig: row.approver_config,
        notificationChannels: (row.notification_channels as readonly NotificationChannelRef[]) ?? [],
        ...(row.quiet_hours ? { quietHours: row.quiet_hours as ApprovalSlaPolicy['quietHours'] } : {}),
      };
    });
  }

  /**
   * Attach an SLA-state row to a freshly-created require_approval proposal.
   * Idempotent: if a row already exists for the proposal, this is a no-op
   * (the FSM is single-attached; re-runs of the gate must not reset it).
   */
  async attachSla(proposalId: string, tenantId: string, actionClass: string): Promise<void> {
    if (!this.isEnabled()) return;
    const policy = await this.resolvePolicy(tenantId, actionClass);
    const now = this.now();
    const nextActionAt = new Date(now.getTime() + policy.initialNotifyAfterSeconds * 1000);
    const hardExpireAt = new Date(now.getTime() + policy.hardExpireAfterSeconds * 1000);

    await this.tx(tenantId, async (client) => {
      // Resolve the policy_id, if a DB row backs this policy. May be NULL
      // when we're using the platform default matrix.
      const policyRows = await client.query<{ id: string }>(
        `SELECT id FROM oweibo.approval_sla_policies
          WHERE tenant_id = $1::uuid AND action_class = $2
          LIMIT 1`,
        [tenantId, policy.actionClass],
      );
      const policyId = policyRows.rows[0]?.id ?? null;

      await client.query(
        `INSERT INTO oweibo.approval_sla_state
           (proposal_id, tenant_id, policy_id, current_stage,
            next_action_at, hard_expire_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3, 0, $4, $5, NOW())
         ON CONFLICT (proposal_id) DO NOTHING`,
        [proposalId, tenantId, policyId, nextActionAt, hardExpireAt],
      );
    });
  }

  /**
   * Mark the SLA row as advanced: the worker writes this after firing a
   * stage's notifications. `escalationDelay` is the delta from now for the
   * NEXT scheduling tick.
   */
  async advanceStage(args: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly newStage: number;
    readonly escalationDelaySeconds: number | null;
    readonly notifiedApprovers: readonly string[];
    readonly details?: unknown;
  }): Promise<void> {
    const now = this.now();
    const nextActionAt = args.escalationDelaySeconds === null
      ? null
      : new Date(now.getTime() + args.escalationDelaySeconds * 1000);
    await this.tx(args.tenantId, async (client) => {
      // When escalationDelaySeconds is null, the FSM has run out of stages —
      // we still need a next_action_at (column is NOT NULL) so we park the
      // row at hard_expire_at where the worker will then auto-reject.
      await client.query(
        `UPDATE oweibo.approval_sla_state
            SET current_stage    = $2,
                next_action_at   = COALESCE($3, hard_expire_at),
                escalation_count = escalation_count + 1,
                notified_approvers = ARRAY(
                  SELECT DISTINCT unnest(notified_approvers || $4::uuid[])
                ),
                last_notification_at = NOW(),
                last_notification_details = $5::jsonb
          WHERE proposal_id = $1::uuid`,
        [
          args.proposalId,
          args.newStage,
          nextActionAt,
          args.notifiedApprovers,
          JSON.stringify(args.details ?? null),
        ],
      );
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function defaultEnabled(): boolean {
  return process.env.APPROVAL_SLA_ENABLED === 'true';
}

// ── Quiet hours pure helper ────────────────────────────────────────────────

/**
 * Returns true when the given instant falls inside the tenant-local quiet
 * window. Windows that span midnight (e.g. start=22, end=6) are handled
 * by ORing the two slices. Used by NotificationRouter before dispatch.
 */
export function isInQuietHours(
  at: Date,
  quietHours: { tz: string; startHour: number; endHour: number } | undefined,
): boolean {
  if (!quietHours) return false;
  if (quietHours.startHour === quietHours.endHour) return false;
  // Reduce to a tenant-local hour using Intl.DateTimeFormat (which respects IANA tz).
  let localHour: number;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: quietHours.tz, hour12: false, hour: '2-digit',
    });
    const parts = formatter.formatToParts(at);
    const h = parts.find((p) => p.type === 'hour')?.value;
    localHour = h ? parseInt(h, 10) % 24 : at.getUTCHours();
  } catch {
    // Unknown timezone — fail open (no quiet-hour suppression).
    return false;
  }
  if (quietHours.startHour < quietHours.endHour) {
    return localHour >= quietHours.startHour && localHour < quietHours.endHour;
  }
  // Window spans midnight, e.g. [22, 6) => 22..23 OR 0..5
  return localHour >= quietHours.startHour || localHour < quietHours.endHour;
}
