/**
 * TaskQueue — async task queue backed by Redis (v5, §16a).
 *
 * Tasks submitted via IntentPipeline are enqueued here and picked up by
 * background workers that call CognitiveEngine.processTask().
 *
 * Uses a Redis list (`LPUSH` / `BRPOP`) for simple, durable FIFO delivery.
 * Per-tenant queues (`task-queue:{tenantId}`) allow rate-limiting per tenant.
 */
import type { IAgentTask } from '@oweibo/core-contracts';

export type TaskHandler = (task: IAgentTask) => Promise<void>;

export class TaskQueue {
  private handlers: TaskHandler[] = [];
  private running = false;

  constructor(
    private readonly redisPush:  (key: string, value: string) => Promise<void>,
    private readonly redisBPop:  (keys: string[], timeoutSeconds: number) => Promise<[string, string] | null>,
    private readonly redisPeek:  (key: string) => Promise<string | null>,
    private readonly tenantIds:  () => string[],
  ) {}

  private queueKey(tenantId: string): string {
    return `task-queue:${tenantId}`;
  }

  /** Enqueue a task for processing. */
  async enqueue(task: IAgentTask): Promise<void> {
    await this.redisPush(this.queueKey(task.tenantId), JSON.stringify(task));
  }

  /** Register a handler to process dequeued tasks. */
  onTask(handler: TaskHandler): void {
    this.handlers.push(handler);
  }

  /**
   * startWorker — begins processing tasks from all tenant queues.
   * Runs until stop() is called. Should be called once in main.ts.
   */
  async startWorker(): Promise<void> {
    this.running = true;

    while (this.running) {
      const tenantIds = this.tenantIds();
      if (tenantIds.length === 0) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const keys   = tenantIds.map(t => this.queueKey(t));
      const result = await this.redisBPop(keys, 5);

      if (!result) continue;  // timeout — loop and re-poll

      const [, raw] = result;
      let task: IAgentTask;

      try {
        task = JSON.parse(raw) as IAgentTask;
      } catch (err) {
        console.error(`[TaskQueue] Failed to parse task: ${(err as Error).message}`);
        continue;
      }

      for (const handler of this.handlers) {
        try {
          await handler(task);
        } catch (err) {
          console.error(`[TaskQueue] Handler error for task ${task.id}: ${(err as Error).message}`);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
