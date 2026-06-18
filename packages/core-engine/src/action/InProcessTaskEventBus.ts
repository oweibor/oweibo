/**
 * Audit-fix (S.1 TaskEventBus): in-process default implementation of
 * ITaskEventBus. Wires the agent-task runtime and the trust-ladder /
 * SLA worker when they share a process. Production deployments with
 * separate processes should replace this with a distributed bus
 * (Redis Streams / NATS / Postgres LISTEN+NOTIFY) — the contract is
 * identical so the swap is transparent.
 */
import type { ITaskEventBus, ProposalDecidedEvent } from '@oweibo/core-contracts';

type Handler = (event: ProposalDecidedEvent) => void;

export class InProcessTaskEventBus implements ITaskEventBus {
  private readonly handlersByTask = new Map<string, Set<Handler>>();

  async publish(event: ProposalDecidedEvent): Promise<void> {
    if (!event.originatingTaskId) return; // no task to wake
    const handlers = this.handlersByTask.get(event.originatingTaskId);
    if (!handlers) return;
    // Snapshot the handlers to avoid mutation-during-iteration if a
    // handler unsubscribes itself.
    for (const h of [...handlers]) {
      try {
        h(event);
      } catch {
        // Per the contract, publish failures must not propagate.
      }
    }
  }

  subscribe(taskId: string, handler: Handler): () => void {
    let bucket = this.handlersByTask.get(taskId);
    if (!bucket) {
      bucket = new Set();
      this.handlersByTask.set(taskId, bucket);
    }
    bucket.add(handler);
    return () => {
      const b = this.handlersByTask.get(taskId);
      if (!b) return;
      b.delete(handler);
      if (b.size === 0) this.handlersByTask.delete(taskId);
    };
  }
}
