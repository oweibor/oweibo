import type { IAgentTask, IAgentTaskResult } from '@oweibo/core-contracts';
import { MultiStrategyPlanner } from './MultiStrategyPlanner.js';
import { GoalDecomposer } from './GoalDecomposer.js';
import { LongTermMemoryStore } from './LongTermMemoryStore.js';
import { PolicyEngine } from '../governance/PolicyEngine.js';
import { AnomalyDetector } from '../observability/AnomalyDetector.js';
import { ContextPruner } from './ContextPruner.js';
import { DistributedContextStore } from './DistributedContextStore.js';
import { SwarmCoordinator } from './SwarmCoordinator.js';
import { TaskEventBus } from '../ingestion/TaskEventBus.js';
import { SessionStore } from '../ingestion/SessionStore.js';
import { OutputDeliveryService } from '../ingestion/OutputDeliveryService.js';
import { TaskHeartbeat } from './TaskHeartbeat.js';
import type { GeneralCodingOrchestrator } from '../general-coding/GeneralCodingOrchestrator.js';
export declare class CognitiveEngine {
    private readonly baseLlm;
    private readonly planner;
    private readonly decomposer;
    private readonly memory;
    private readonly policy;
    private readonly anomaly;
    private readonly contextStore;
    private readonly contextPruner;
    private readonly swarm;
    private readonly eventBus;
    private readonly sessions;
    private readonly delivery;
    private readonly heartbeat;
    private readonly generalCodingOrchestrator;
    constructor(baseLlm: {
        baseUrl: string;
        model: string;
    }, planner: MultiStrategyPlanner, decomposer: GoalDecomposer, memory: LongTermMemoryStore, policy: PolicyEngine, anomaly: AnomalyDetector, contextStore: DistributedContextStore, contextPruner: ContextPruner, swarm: SwarmCoordinator, eventBus: TaskEventBus, sessions: SessionStore, delivery: OutputDeliveryService, heartbeat: TaskHeartbeat, generalCodingOrchestrator: GeneralCodingOrchestrator);
    processTask(task: IAgentTask): Promise<IAgentTaskResult>;
}
//# sourceMappingURL=CognitiveEngine.d.ts.map