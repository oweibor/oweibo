"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=ITaskEventBus.js.map