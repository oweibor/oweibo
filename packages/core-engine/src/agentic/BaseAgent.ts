/**
 * BaseAgent — abstract base for all specialist agents in the swarm.
 *
 * Provides:
 *   - Isolated memory scope (`{role}:{taskId}`) via ISemanticMemoryStore
 *   - Structured AgentMessage handling (assign → process → result/challenge)
 *   - Langfuse span emission for every message processed
 *   - Helper methods: recall(), remember(), respond(), challenge()
 *
 * Subclasses implement process() which receives an 'assign' message and returns
 * a 'result' or 'challenge' message. ConflictResolver handles challenges.
 */
import type { IAgent, AgentMessage, AgentRole, ILLMClient } from '@oweibo/core-contracts';
import type { ISemanticMemoryStore } from '@oweibo/core-contracts';
import type { LangfuseTraceClient } from 'langfuse';
import { randomUUID } from 'crypto';

export abstract class BaseAgent implements IAgent {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly memoryScope: string;

  constructor(
    role: AgentRole,
    protected readonly llm: ILLMClient,
    protected readonly memory: ISemanticMemoryStore,
    protected readonly systemPrompt: string,
    protected readonly trace: LangfuseTraceClient,
    protected readonly taskId: string,
    private readonly tenantId: string,
  ) {
    this.role        = role;
    this.agentId     = `${role}:${taskId}`;
    this.memoryScope = `${role}:${taskId}`;
  }

  abstract process(message: AgentMessage): Promise<AgentMessage>;

  protected async recall(query: string, topK = 5): Promise<string> {
    const entries = await this.memory.recall({ tenantId: this.tenantId, query, topK });
    if (entries.length === 0) return '';
    return entries.map(e => `[Memory] ${e.summary}`).join('\n');
  }

  protected async remember(content: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.memory.store({
      scope: {
        tenantId: this.tenantId,
        taskId:   this.taskId,
      },
      kind:       'tool-heuristic',
      summary:    content,
      detail:     metadata,
      importance: 0.5,
    });
  }

  protected respond(original: AgentMessage, payload: unknown): AgentMessage {
    return {
      id:        randomUUID(),
      from:      this.agentId,
      to:        original.from,
      type:      'result',
      payload,
      traceId:   original.traceId,
      timestamp: Date.now(),
    };
  }

  protected challengeMsg(original: AgentMessage, reason: string): AgentMessage {
    return {
      id:        randomUUID(),
      from:      this.agentId,
      to:        original.from,
      type:      'challenge',
      payload:   { reason, originalPayload: original.payload },
      traceId:   original.traceId,
      timestamp: Date.now(),
    };
  }
}

// DONE: Phase A.4 — static prompt constants removed; prompts now come from CohortRouter.
// Stable-v0 fallback strings live in CohortRouter.STABLE_V0_FALLBACKS.

/** Concrete generic agent — used by SwarmCoordinator for the four standard roles. */
export class GenericAgent extends BaseAgent {
  async process(message: AgentMessage): Promise<AgentMessage> {
    const out = await this.llm.generate({
      systemPrompt: this.systemPrompt,
      userPrompt:   typeof message.payload === 'string' ? message.payload : JSON.stringify(message.payload),
    });
    return this.respond(message, out.output ?? '');
  }
}
