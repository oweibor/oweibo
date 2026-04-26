/**
 * SessionReaper — subscribes to Redis keyspace expiry events and calls destroySession()
 * whenever a session TTL expires, preventing Playwright context leaks in contextPool.
 * (v9.5.3 S3 — NEW FILE)
 *
 * Infrastructure prerequisite — run once in the oweibo bootstrap script:
 *   redis-cli CONFIG SET notify-keyspace-events "Ex"
 */
import type { Redis } from 'ioredis';
export interface ILogger {
    info(obj: Record<string, unknown> | string, msg?: string): void;
    error(obj: Record<string, unknown> | string, msg?: string): void;
    warn(obj: Record<string, unknown> | string, msg?: string): void;
    debug(obj: Record<string, unknown> | string, msg?: string): void;
}
export interface ISessionManagerForReaper {
    destroySession(tenantId: string, sessionId: string): Promise<void>;
}
export declare class SessionReaper {
    private readonly redis;
    private readonly sessionManager;
    private readonly logger;
    private subscriber;
    constructor(redis: Redis, sessionManager: ISessionManagerForReaper, logger: ILogger);
    start(): Promise<void>;
    stop(): void;
    private handleExpiry;
}
//# sourceMappingURL=SessionReaper.d.ts.map