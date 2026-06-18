/**
 * Audit-fix (S.1 TaskEventBus): seam for waking up an originating agent
 * task when an action proposal it issued has been decided.
 *
 * Context: an agent task that emits a `require_approval` action pauses
 * waiting for the approval. When the SLA expires (auto-reject) or a
 * human approves/rejects, the task needs to wake and either retry, give
 * up, or continue. Without a wake signal, the task hangs indefinitely
 * — the symptom S.1 mitigates incorrectly assumes pre-existing
 * infrastructure that did not exist.
 *
 * This contract is intentionally pluggable: an in-process implementation
 * uses an EventEmitter; a distributed implementation publishes to NATS /
 * Redis Streams / Postgres LISTEN/NOTIFY. The trust-ladder calls only
 * `publish()`; the agent-task runtime calls `subscribe()`.
 */

export type ProposalDecisionKind =
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'auto_promoted_via_grant';

export interface ProposalDecidedEvent {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly originatingTaskId: string | null;
  readonly actionId: string;
  readonly actionClass: string;
  readonly decision: ProposalDecisionKind;
  readonly decidedByUserId?: string;
  readonly reason?: string;
  readonly decidedAtMs: number;
}

/**
 * Task event bus. The default in-process implementation (see
 * core-engine's InProcessTaskEventBus) is sufficient when the gate
 * and the agent task share a process; production with separate
 * processes wires a distributed implementation.
 *
 * `publish()` is fire-and-forget — failures MUST NOT bubble back to
 * the SLA worker; the task wake is a best-effort signal, not a
 * correctness guarantee. The proposal state itself is the source of
 * truth.
 */
export interface ITaskEventBus {
  publish(event: ProposalDecidedEvent): Promise<void>;
  /**
   * Subscribe to decisions affecting a specific task. Returns a
   * function to call to cancel the subscription. The handler is
   * called once per matching event; concurrent invocations are
   * possible (events are not serialized).
   */
  subscribe(
    taskId: string,
    handler: (event: ProposalDecidedEvent) => void,
  ): () => void;
}
