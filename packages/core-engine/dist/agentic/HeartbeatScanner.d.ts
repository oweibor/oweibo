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
export declare class HeartbeatScanner {
    private readonly redis;
    private readonly onStalled;
    private readonly onEscalate;
    private timer;
    private readonly stallCounts;
    private readonly config;
    constructor(redis: Redis, onStalled: (task: StalledTask) => Promise<void>, onEscalate: (task: StalledTask) => Promise<void>, config?: Partial<HeartbeatScannerConfig>);
    start(): void;
    stop(): void;
    scan(): Promise<StalledTask[]>;
    clearStallCount(taskId: string): void;
}
//# sourceMappingURL=HeartbeatScanner.d.ts.map