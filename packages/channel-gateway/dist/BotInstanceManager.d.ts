import type { IChannelAdapter } from './adapters/IChannelAdapter.js';
import type { ChannelCredentialVault } from './ChannelCredentialVault.js';
import type { ChannelRouter } from './ChannelRouter.js';
import type { Platform } from '@oweibo/channel-contracts';
export interface BotRegistration {
    tenantId: string;
    platform: Platform;
}
/**
 * Manages the lifecycle of per-tenant bot instances.
 *
 * ISOLATION GUARANTEE: the `onMessage` handler passed to adapter.start() is a closure
 * that captures `tenantId` at registration time. The adapter never sees `tenantId`
 * explicitly — it cannot be overridden by message content. ChannelRouter receives it
 * as a parameter from this closure, making cross-tenant routing structurally impossible
 * regardless of what any user sends.
 */
export declare class BotInstanceManager {
    private readonly adapters;
    private readonly credVault;
    private readonly router;
    private readonly instances;
    constructor(adapters: Map<Platform, IChannelAdapter>, credVault: ChannelCredentialVault, router: ChannelRouter);
    register(reg: BotRegistration): Promise<void>;
    deregister(reg: BotRegistration): Promise<void>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=BotInstanceManager.d.ts.map