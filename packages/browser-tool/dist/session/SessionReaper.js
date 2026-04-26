"use strict";
/**
 * SessionReaper — subscribes to Redis keyspace expiry events and calls destroySession()
 * whenever a session TTL expires, preventing Playwright context leaks in contextPool.
 * (v9.5.3 S3 — NEW FILE)
 *
 * Infrastructure prerequisite — run once in the oweibo bootstrap script:
 *   redis-cli CONFIG SET notify-keyspace-events "Ex"
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionReaper = void 0;
const SESSION_KEY_RE = /^oweibo:browser:([^:]+):session:([^:]+)$/;
class SessionReaper {
    redis;
    sessionManager;
    logger;
    subscriber;
    constructor(redis, sessionManager, logger) {
        this.redis = redis;
        this.sessionManager = sessionManager;
        this.logger = logger;
    }
    async start() {
        this.subscriber = this.redis.duplicate();
        await this.subscriber.subscribe('__keyevent@0__:expired');
        this.subscriber.on('message', (_ch, key) => void this.handleExpiry(key));
        this.logger.info('SessionReaper started.');
    }
    stop() {
        this.subscriber?.disconnect();
    }
    async handleExpiry(key) {
        const match = key.match(SESSION_KEY_RE);
        if (!match)
            return;
        const [, tenantId, sessionId] = match;
        this.logger.info({ tenantId, sessionId }, 'Session TTL expired — reaping.');
        try {
            await this.sessionManager.destroySession(tenantId, sessionId);
        }
        catch (err) {
            this.logger.error({ tenantId, sessionId, err }, 'SessionReaper: destroySession failed.');
        }
    }
}
exports.SessionReaper = SessionReaper;
//# sourceMappingURL=SessionReaper.js.map