import type { Redis } from 'ioredis';
import type { Platform } from '@oweibo/channel-contracts';
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
export declare class IdentityResolver {
    private readonly redis;
    constructor(redis: Redis);
    resolve(platform: Platform, platformUserId: string, tenantId: string): Promise<ResolvedIdentity>;
}
//# sourceMappingURL=IdentityResolver.d.ts.map