/**
 * BaseAgent — abstract base for all specialist agents in the swarm.
 *
 * Provides:
 *   - Isolated memory scope (`{role}:{taskId}`) via LongTermMemoryStore
 *   - Structured AgentMessage handling (assign → process → result/challenge)
 *   - Langfuse span emission for every message processed
 *   - Helper methods: recall(), remember(), respond(), challenge()
 *
 * Subclasses implement process() which receives an 'assign' message and returns
 * a 'result' or 'challenge' message. ConflictResolver handles challenges.
 */
import type { IAgent, AgentMessage, AgentRole, ILLMClient } from '@oweibo/core-contracts';
import type { LongTermMemoryStore } from './LongTermMemoryStore.js';
import type { LangfuseTraceClient } from 'langfuse';
import { randomUUID } from 'crypto';

export abstract class BaseAgent implements IAgent {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly memoryScope: string;

  constructor(
    role: AgentRole,
    protected readonly llm: ILLMClient,
    protected readonly memory: LongTermMemoryStore,
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
    const entries = await this.memory.recall(this.tenantId, query, { topK });
    if (entries.length === 0) return '';
    return entries.map(e => `[Memory] ${e.entry.summary}`).join('\n');
  }

  protected async remember(content: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.memory.store({
      tenantId:      this.tenantId,
      scope:         this.memoryScope,
      type:          'tool-heuristic',
      tier:          'episodic',
      summary:       content,
      detail:        metadata ?? {},
      relevanceTags: [],
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

// ─── System prompts (referenced by SwarmCoordinator) ─────────────────────────
export const ARCHITECT_SYSTEM_PROMPT =
  'You are the Architect agent. Decompose goals into a precise, ordered plan.';
export const EXECUTOR_SYSTEM_PROMPT =
  'You are the Executor agent. Carry out plan steps faithfully and report results.';
export const REVIEWER_SYSTEM_PROMPT =
  'You are the Reviewer agent. Audit executor outputs and challenge defects.';
export const DOMAIN_SPECIALIST_SYSTEM_PROMPT =
  'You are a Domain Specialist. Provide expertise specific to the requested domain.';

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
