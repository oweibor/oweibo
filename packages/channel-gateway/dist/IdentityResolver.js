"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdentityResolver = void 0;
const crypto_1 = require("crypto");
/**
 * Redis key schema:
 *   identity:{tenantId}:{platform}:{platformUserId}  →  { userId }   TTL: 90 days
 *
 * The tenantId in the key comes from the BotInstanceManager closure, not from the message.
 * An attacker cannot influence which tenantId they are resolved into by spoofing their
 * platformUserId — the tenantId half is already fixed by the bot token.
 */
class IdentityResolver {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async resolve(platform, platformUserId, tenantId) {
        const redisKey = `identity:${tenantId}:${platform}:${platformUserId}`;
        const existing = await this.redis.get(redisKey);
        let userId;
        if (existing) {
            ({ userId } = JSON.parse(existing));
        }
        else {
            userId = (0, crypto_1.randomUUID)();
            await this.redis.set(redisKey, JSON.stringify({ userId }), 'EX', 60 * 60 * 24 * 90);
        }
        return {
            userId,
            tenantId,
            sessionId: `${tenantId}:${platform}:${platformUserId}`,
        };
    }
}
exports.IdentityResolver = IdentityResolver;
//# sourceMappingURL=IdentityResolver.js.map