// packages/channel-gateway/src/ChannelRouter.ts
// Inbound → IntentPipeline (§21.8)
// channel-gateway may ONLY import from core-engine/ingestion/* (dependency-cruiser enforced)
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
export class ChannelRouter {
  constructor(
    private readonly identity: IdentityResolver,
    private readonly commandParser: ChannelCommandParser,
    private readonly intentPipeline: IIntentPipelineGateway,
  ) {}

  async handle(msg: InboundChannelMessage, tenantId: string): Promise<void> {
    const { userId, sessionId } = await this.identity.resolve(
      msg.platform, msg.platformUserId, tenantId,
    );

    // Slash commands → TaskInterventionGateway (not new tasks)
    if (msg.text.trim().startsWith('/')) {
      await this.commandParser.parse(msg, tenantId, userId);
      return;
    }

    const replyTarget: ChannelReplyTarget = {
      platform: msg.platform,
      botTokenHash: require('crypto').createHash('sha256').update(msg.botToken).digest('hex'),
      chatId: msg.platformChatId,
      threadId: msg.messageId,
    };

    await this.intentPipeline.submit({
      text: msg.text,
      userId,
      tenantId,
      sessionId,
      channel: msg.platform,
      attachments: msg.attachments,
      deliveryConfig: {
        mode: 'channel-reply',
        channelReplyTarget: replyTarget,
      },
    });
  }
}
