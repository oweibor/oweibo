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
export declare abstract class BaseAgent implements IAgent {
    protected readonly llm: ILLMClient;
    protected readonly memory: ISemanticMemoryStore;
    protected readonly systemPrompt: string;
    protected readonly trace: LangfuseTraceClient;
    protected readonly taskId: string;
    private readonly tenantId;
    readonly agentId: string;
    readonly role: AgentRole;
    readonly memoryScope: string;
    constructor(role: AgentRole, llm: ILLMClient, memory: ISemanticMemoryStore, systemPrompt: string, trace: LangfuseTraceClient, taskId: string, tenantId: string);
    abstract process(message: AgentMessage): Promise<AgentMessage>;
    protected recall(query: string, topK?: number): Promise<string>;
    protected remember(content: string, metadata?: Record<string, unknown>): Promise<void>;
    protected respond(original: AgentMessage, payload: unknown): AgentMessage;
    protected challengeMsg(original: AgentMessage, reason: string): AgentMessage;
}
/** Concrete generic agent — used by SwarmCoordinator for the four standard roles. */
export declare class GenericAgent extends BaseAgent {
    process(message: AgentMessage): Promise<AgentMessage>;
}
//# sourceMappingURL=BaseAgent.d.ts.map