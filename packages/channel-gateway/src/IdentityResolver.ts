// packages/channel-gateway/src/IdentityResolver.ts
// Platform identity → oweibo identity (§21.6)
import type { Redis } from 'ioredis';
import type { Platform } from '@oweibo/channel-contracts';
import { randomUUID } from 'crypto';

export interface ResolvedIdentity {
  /** oweibo internal UUID — stable across sessions */
  userId: string;
  /** Sourced from bot token binding, NOT from message content */
  tenantId: string;
  /** `{tenantId}:{platform}:{platformUserId}` — cross-tenant collision impossible */
  sessionId: string;
}

/**
 * Redis key schema:
 *   identity:{tenantId}:{platform}:{platformUserId}  →  { userId }   TTL: 90 days
 *
 * The tenantId in the key comes from the BotInstanceManager closure, not from the message.
 * An attacker cannot influence which tenantId they are resolved into by spoofing their
 * platformUserId — the tenantId half is already fixed by the bot token.
 */
export class IdentityResolver {
  constructor(private readonly redis: Redis) {}

  async resolve(
    platform: Platform,
    platformUserId: string,
    tenantId: string,
  ): Promise<ResolvedIdentity> {
    const redisKey = `identity:${tenantId}:${platform}:${platformUserId}`;
    const existing = await this.redis.get(redisKey);

    let userId: string;
    if (existing) {
      ({ userId } = JSON.parse(existing) as { userId: string });
    } else {
      userId = randomUUID();
      await this.redis.set(
        redisKey,
        JSON.stringify({ userId }),
        'EX', 60 * 60 * 24 * 90, // 90 days
      );
    }

    return {
      userId,
      tenantId,
      sessionId: `${tenantId}:${platform}:${platformUserId}`,
    };
  }
}
