/**
 * HeartbeatScanner — system-wide watchdog for stalled tasks (§16e).
 *
 * Periodically scans all active tasks via Redis. Tasks that haven't
 * sent a heartbeat within the configured timeout are flagged as stalled.
 * Stalled tasks are re-enqueued or escalated to HITL.
 */
import type { Redis } from 'ioredis';

export interface StalledTask {
  readonly taskId: string;
  readonly lastHeartbeat: number;
  readonly stalledForMs: number;
  readonly currentStage: string;
  readonly workerId: string;
}

export interface HeartbeatScannerConfig {
  readonly scanIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxStallBeforeEscalation: number;
}

const DEFAULT_CONFIG: HeartbeatScannerConfig = {
  scanIntervalMs: 10_000,
  heartbeatTimeoutMs: 60_000,
  maxStallBeforeEscalation: 3,
};

export class HeartbeatScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stallCounts = new Map<string, number>();
  private readonly config: HeartbeatScannerConfig;

  constructor(
    private readonly redis: Redis,
    private readonly onStalled: (task: StalledTask) => Promise<void>,
    private readonly onEscalate: (task: StalledTask) => Promise<void>,
    config: Partial<HeartbeatScannerConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scan(), this.config.scanIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async scan(): Promise<StalledTask[]> {
    const now = Date.now();
    const stalled: StalledTask[] = [];

    // Scan all heartbeat keys
    const keys = await this.redis.keys('heartbeat:task:*');
    for (const key of keys) {
      const data = await this.redis.hgetall(key);
      if (!data.lastBeat) continue;

      const lastHeartbeat = parseInt(data.lastBeat, 10);
      const elapsed = now - lastHeartbeat;

      if (elapsed > this.config.heartbeatTimeoutMs) {
        const taskId = key.replace('heartbeat:task:', '');
        const stalledTask: StalledTask = {
          taskId,
          lastHeartbeat,
          stalledForMs: elapsed,
          currentStage: data.stage ?? 'unknown',
          workerId: data.workerId ?? 'unknown',
        };

        const count = (this.stallCounts.get(taskId) ?? 0) + 1;
        this.stallCounts.set(taskId, count);

        if (count >= this.config.maxStallBeforeEscalation) {
          await this.onEscalate(stalledTask);
          this.stallCounts.delete(taskId);
        } else {
          await this.onStalled(stalledTask);
        }

        stalled.push(stalledTask);
      }
    }

    return stalled;
  }

  clearStallCount(taskId: string): void {
    this.stallCounts.delete(taskId);
  }
}
