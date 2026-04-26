/**
 * IntentPipeline — sole task entry point (v5, §16a).
 *
 * ALL tasks enter the system through IntentPipeline.submit(). No other path to
 * CognitiveEngine exists. This is the "front door" enforced by dependency-cruiser.
 *
 * Responsibilities:
 *   1. Accept a RawIntent from any channel (REST, CLI, channel-gateway)
 *   2. Generate a unique taskId (UUIDv4)
 *   3. Call IntentClarifier.classifyTaskMode() to determine routing
 *   4. Validate the resulting IAgentTask
 *   5. Register task ownership in TaskInterventionGateway
 *   6. Publish 'task-accepted' to TaskEventBus
 *   7. Enqueue the task on TaskQueue for async processing
 *
 * IntentPipeline is intentionally thin — it validates, routes, and enqueues.
 * All heavy lifting happens in CognitiveEngine (factory path) or
 * GeneralCodingOrchestrator (general-coding path).
 */
import { randomUUID } from 'crypto';
import type { IAgentTask } from '@oweibo/core-contracts';
import type { IntentClarifier, RawIntent } from './IntentClarifier.js';
import type { TaskEventBus } from './TaskEventBus.js';
import type { TaskInterventionGateway } from './TaskInterventionGateway.js';
import type { TaskQueue } from '../agentic/TaskQueue.js';

export interface SubmitResult {
  readonly taskId: string;
  readonly taskMode: 'factory' | 'general-coding';
  readonly sessionId: string;
}

export class IntentPipeline {
  constructor(
    private readonly clarifier:     IntentClarifier,
    private readonly eventBus:      TaskEventBus,
    private readonly interventions: TaskInterventionGateway,
    private readonly taskQueue:     TaskQueue,
  ) {}

  /**
   * submit — accepts a raw intent, classifies it, and enqueues a validated IAgentTask.
   * Returns immediately with the taskId so the caller can subscribe to progress events.
   */
  async submit(intent: RawIntent): Promise<SubmitResult> {
    const taskId = randomUUID();

    // 1. Classify the intent
    const classified = await this.clarifier.classifyTaskMode(intent);

    // 2. Build the validated task
    const task = this.clarifier.buildTask(intent, classified, taskId);

    // 3. Validate required fields
    this.validate(task);

    // 4. Register task ownership (for intervention auth)
    if (intent.userId) {
      await this.interventions.registerOwner(taskId, intent.userId);
    }

    // 5. Publish task-accepted event
    await this.eventBus.publish(intent.sessionId, {
      taskId,
      type:    'task-accepted',
      message: `Task accepted: ${classified.taskMode} mode. Queued for processing…`,
      progress: 5,
    });

    // 6. Enqueue for async processing
    await this.taskQueue.enqueue(task);

    return {
      taskId,
      taskMode:  classified.taskMode,
      sessionId: intent.sessionId,
    };
  }

  private validate(task: IAgentTask): void {
    if (!task.tenantId) throw new Error('[IntentPipeline] tenantId is required');
    if (!task.goal?.description) throw new Error('[IntentPipeline] goal.description is required');
    if (task.taskMode === 'general-coding' && !task.repoPath) {
      throw new Error('[IntentPipeline] repoPath is required for general-coding tasks');
    }
  }
}
