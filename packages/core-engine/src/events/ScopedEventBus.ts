/**
 * ScopedEventBus — in-process typed event bus scoped to a single task/agent session.
 *
 * Used by the swarm for agent-to-agent communication (AgentMessage routing).
 * Each task gets its own ScopedEventBus instance — cross-task contamination is impossible.
 *
 * Backed by EventEmitter3 for performance; no Redis (that's TaskEventBus's responsibility).
 * Implements IScopedEventBus from core-contracts.
 */
import { EventEmitter } from 'eventemitter3';
import type { IScopedEventBus } from '@oweibo/core-contracts';
import type { AgentMessage } from '@oweibo/core-contracts';

export class ScopedEventBus implements Omit<IScopedEventBus, 'emit' | 'on'> {
  emit(_event: string, ..._args: unknown[]): void { /* not used */ }
  on(_event: string, _handler: (...args: unknown[]) => void): void { /* not used */ }

  private readonly emitter = new EventEmitter();
  private readonly taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  publish(message: AgentMessage): void {
    const channel = message.to === 'broadcast'
      ? `${this.taskId}:broadcast`
      : `${this.taskId}:${message.to}`;
    this.emitter.emit(channel, message);
  }

  subscribe(agentId: string, handler: (message: AgentMessage) => void): () => void {
    const direct    = `${this.taskId}:${agentId}`;
    const broadcast = `${this.taskId}:broadcast`;
    this.emitter.on(direct, handler);
    this.emitter.on(broadcast, handler);
    return () => {
      this.emitter.off(direct, handler);
      this.emitter.off(broadcast, handler);
    };
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
