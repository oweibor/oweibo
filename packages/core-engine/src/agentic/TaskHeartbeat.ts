// packages/core-engine/src/agentic/TaskHeartbeat.ts
// Per-task stall detection and proactive perception (§16e.1)
import type { Redis } from 'ioredis';

export class TaskHeartbeat {
  private static readonly HEARTBEAT_KEY = (taskId: string) => `task:${taskId}:heartbeat`;
  private static readonly HEARTBEAT_TTL_SEC = 30;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly redis: Redis) {}

  async start(taskId: string, sessionId: string): Promise<void> {
    await this.beat(taskId);
    const timer = setInterval(async () => {
      await this.beat(taskId);
    }, 15_000);
    this.timers.set(taskId, timer);
  }

  async cancel(taskId: string): Promise<void> {
    const timer = this.timers.get(taskId);
    if (timer) { clearInterval(timer); this.timers.delete(taskId); }
    await this.redis.del(TaskHeartbeat.HEARTBEAT_KEY(taskId));
  }

  private async beat(taskId: string): Promise<void> {
    await this.redis.setex(
      TaskHeartbeat.HEARTBEAT_KEY(taskId),
      TaskHeartbeat.HEARTBEAT_TTL_SEC,
      Date.now().toString(),
    );
  }
}
