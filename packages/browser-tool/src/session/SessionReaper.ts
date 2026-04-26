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

const SESSION_KEY_RE = /^oweibo:browser:([^:]+):session:([^:]+)$/;

export class SessionReaper {
  private subscriber: Redis | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly sessionManager: ISessionManagerForReaper,
    private readonly logger: ILogger,
  ) {}

  async start(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe('__keyevent@0__:expired');
    this.subscriber.on('message', (_ch: string, key: string) =>
      void this.handleExpiry(key),
    );
    this.logger.info('SessionReaper started.');
  }

  stop(): void {
    this.subscriber?.disconnect();
  }

  private async handleExpiry(key: string): Promise<void> {
    const match = key.match(SESSION_KEY_RE);
    if (!match) return;
    const [, tenantId, sessionId] = match;
    this.logger.info({ tenantId, sessionId }, 'Session TTL expired — reaping.');
    try {
      await this.sessionManager.destroySession(tenantId!, sessionId!);
    } catch (err) {
      this.logger.error(
        { tenantId, sessionId, err },
        'SessionReaper: destroySession failed.',
      );
    }
  }
}
