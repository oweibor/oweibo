import type { IScopedEventBus } from '@oweibo/core-contracts';
import type { AgentMessage } from '@oweibo/core-contracts';
export declare class ScopedEventBus implements Omit<IScopedEventBus, 'emit' | 'on'> {
    emit(_event: string, ..._args: unknown[]): void;
    on(_event: string, _handler: (...args: unknown[]) => void): void;
    private readonly emitter;
    private readonly taskId;
    constructor(taskId: string);
    publish(message: AgentMessage): void;
    subscribe(agentId: string, handler: (message: AgentMessage) => void): () => void;
    dispose(): void;
}
//# sourceMappingURL=ScopedEventBus.d.ts.map