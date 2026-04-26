import type { IntentClarifier, RawIntent } from './IntentClarifier.js';
import type { TaskEventBus } from './TaskEventBus.js';
import type { TaskInterventionGateway } from './TaskInterventionGateway.js';
import type { TaskQueue } from '../agentic/TaskQueue.js';
export interface SubmitResult {
    readonly taskId: string;
    readonly taskMode: 'factory' | 'general-coding';
    readonly sessionId: string;
}
export declare class IntentPipeline {
    private readonly clarifier;
    private readonly eventBus;
    private readonly interventions;
    private readonly taskQueue;
    constructor(clarifier: IntentClarifier, eventBus: TaskEventBus, interventions: TaskInterventionGateway, taskQueue: TaskQueue);
    /**
     * submit — accepts a raw intent, classifies it, and enqueues a validated IAgentTask.
     * Returns immediately with the taskId so the caller can subscribe to progress events.
     */
    submit(intent: RawIntent): Promise<SubmitResult>;
    private validate;
}
//# sourceMappingURL=IntentPipeline.d.ts.map