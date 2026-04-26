// packages/core-engine/src/agentic/ContextPruner.ts
// Context window management — prunes long context chains (§16c.1)
import type { LangfuseTraceClient } from 'langfuse';
import type { DistributedContextStore } from './DistributedContextStore.js';

export class ContextPruner {
  private static readonly MAX_MESSAGES = 20;

  constructor(private readonly contextStore: DistributedContextStore) {}

  async pruneIfNeeded(taskId: string, trace: LangfuseTraceClient): Promise<void> {
    const ctx = await this.contextStore.load(taskId);
    if (!ctx) return;

    const messages = (ctx as { agentMessages?: unknown[] }).agentMessages ?? [];
    if (messages.length <= ContextPruner.MAX_MESSAGES) return;

    // Keep first 5 (planning context) and last 10 (most recent execution context)
    const pruned = [
      ...messages.slice(0, 5),
      { type: 'system', payload: `[${messages.length - 15} messages pruned to fit context window]` },
      ...messages.slice(-10),
    ];

    await this.contextStore.save({ ...ctx, agentMessages: pruned });
  }
}
