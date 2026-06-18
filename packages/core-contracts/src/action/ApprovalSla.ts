/**
 * S.1 (ttv-action-safety-v2): Approval SLA contracts.
 *
 * A `require_approval` proposal sits in a managed lifecycle:
 *   1. SLA attached at proposal-create time
 *   2. Initial notification fires after `initialNotifyAfter` seconds
 *   3. Escalations fire at each `escalateAfter[i]` boundary
 *   4. Hard expiry auto-rejects at `hardExpireAfter`
 *
 * The same policy contract covers per-class overrides and the tenant
 * default (action_class = '*').
 */
import type { ActionClass } from './ActionClass.js';

export type ApproverResolutionKind = 'org_graph' | 'role_based' | 'explicit_list';

export type NotificationChannelKind = 'slack' | 'email' | 'webhook' | 'in_app';

export type FireEvent =
  | 'initial'
  | `escalation:${number}`
  | 'expiry'
  | 'decision';

export interface NotificationChannelRef {
  readonly channelKind: NotificationChannelKind;
  /** Channel-specific config (slack workspace, webhook URL, etc.) */
  readonly config: unknown;
  /** Subset of fire events the channel should listen to. */
  readonly fireOn: readonly ('initial' | 'escalation' | 'expiry' | 'decision')[];
}

export interface QuietHours {
  /** IANA timezone, e.g. `America/New_York`. */
  readonly tz: string;
  /** 0..23 — inclusive start hour in tenant-local time. */
  readonly startHour: number;
  /** 0..23 — exclusive end hour in tenant-local time. */
  readonly endHour: number;
}

export interface ApprovalSlaPolicy {
  readonly tenantId: string;
  /** Specific class or `'*'` for the tenant default. */
  readonly actionClass: ActionClass | '*';
  readonly initialNotifyAfterSeconds: number;
  /** Successive escalation deltas. Each entry is the delta from the previous stage. */
  readonly escalateAfterSeconds: readonly number[];
  readonly hardExpireAfterSeconds: number;
  readonly approverResolution: ApproverResolutionKind;
  /** Shape depends on `approverResolution`. */
  readonly approverConfig: unknown;
  readonly notificationChannels: readonly NotificationChannelRef[];
  readonly quietHours?: QuietHours;
}

export interface ApprovalSlaState {
  readonly proposalId: string;
  readonly tenantId: string;
  readonly policyId: string | null;
  readonly currentStage: number;
  /** Next time the worker will look at this row. */
  readonly nextActionAt: string;
  readonly hardExpireAt: string;
  readonly notifiedApprovers: readonly string[];
  readonly escalationCount: number;
  readonly lastNotificationAt?: string;
}

export interface NotificationDispatchRequest {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly recipientUserId?: string;
  readonly recipientHandle?: string;
  readonly channelKind: NotificationChannelKind;
  readonly fireEvent: FireEvent;
  readonly title: string;
  readonly body: string;
  readonly linkPath?: string;
  readonly urgency?: 'normal' | 'urgent';
}

export type DispatchStatus =
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'suppressed_quiet_hours';

export interface DispatchResult {
  readonly status: DispatchStatus;
  readonly error?: string;
  readonly dispatchedAt?: string;
}

/**
 * A pluggable notification channel adapter. In-app is the always-on
 * guarantee; external channels (slack, email, webhook) are best-effort
 * with the in-app channel as the fallback floor.
 */
export interface INotificationChannel {
  readonly kind: NotificationChannelKind;
  dispatch(req: NotificationDispatchRequest): Promise<DispatchResult>;
}
