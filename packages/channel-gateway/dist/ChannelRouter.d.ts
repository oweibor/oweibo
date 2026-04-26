import type { InboundChannelMessage } from './adapters/IChannelAdapter.js';
import type { ChannelReplyTarget } from '@oweibo/channel-contracts';
import type { IdentityResolver } from './IdentityResolver.js';
import type { ChannelCommandParser } from './ChannelCommandParser.js';
/**
 * Minimal IntentPipeline surface — channel-gateway may only call submit().
 * The full IntentPipeline lives in core-engine/ingestion which is the allowed import.
 */
export interface IIntentPipelineGateway {
    submit(input: {
        text: string;
        userId: string;
        tenantId: string;
        sessionId: string;
        channel: string;
        attachments?: Buffer[];
        deliveryConfig: {
            mode: 'channel-reply';
            channelReplyTarget: ChannelReplyTarget;
        };
    }): Promise<void>;
}
/**
 * Routes all inbound channel messages.
 *
 * ISOLATION CONTRACT: tenantId is received as a parameter from BotInstanceManager's
 * onMessage closure. ChannelRouter never performs its own tenantId lookup.
 * A message cannot influence which tenant context it lands in.
 */
export declare class ChannelRouter {
    private readonly identity;
    private readonly commandParser;
    private readonly intentPipeline;
    constructor(identity: IdentityResolver, commandParser: ChannelCommandParser, intentPipeline: IIntentPipelineGateway);
    handle(msg: InboundChannelMessage, tenantId: string): Promise<void>;
}
//# sourceMappingURL=ChannelRouter.d.ts.map