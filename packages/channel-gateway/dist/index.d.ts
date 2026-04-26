import { BotInstanceManager } from './BotInstanceManager.js';
import type { Platform } from '@oweibo/channel-contracts';
import type { ISecretsManager } from '@oweibo/core-contracts';
import type { Redis } from 'ioredis';
import type { IIntentPipelineGateway } from './ChannelRouter.js';
import type { ITaskEventBusGateway, IDistributedContextStoreGateway } from './ChannelEventBridge.js';
import type { ITaskInterventionGatewayGateway } from './ChannelCommandParser.js';
export interface GatewayDeps {
    secrets: ISecretsManager;
    redis: Redis;
    intentPipeline: IIntentPipelineGateway;
    eventBus: ITaskEventBusGateway;
    interventionGw: ITaskInterventionGatewayGateway;
    contextStore: IDistributedContextStoreGateway;
    initialRegistrations: Array<{
        tenantId: string;
        platform: Platform;
    }>;
}
export declare function startGateway(deps: GatewayDeps): Promise<BotInstanceManager>;
export { BotInstanceManager } from './BotInstanceManager.js';
export { ChannelCredentialVault, DuplicateBotTokenError } from './ChannelCredentialVault.js';
export { IdentityResolver } from './IdentityResolver.js';
export { ChannelRouter } from './ChannelRouter.js';
export { ChannelEventBridge } from './ChannelEventBridge.js';
export { ChannelCommandParser } from './ChannelCommandParser.js';
export type { IChannelAdapter, InboundChannelMessage } from './adapters/IChannelAdapter.js';
//# sourceMappingURL=index.d.ts.map