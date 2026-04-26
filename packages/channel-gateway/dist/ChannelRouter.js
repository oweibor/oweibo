"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelRouter = void 0;
/**
 * Routes all inbound channel messages.
 *
 * ISOLATION CONTRACT: tenantId is received as a parameter from BotInstanceManager's
 * onMessage closure. ChannelRouter never performs its own tenantId lookup.
 * A message cannot influence which tenant context it lands in.
 */
class ChannelRouter {
    identity;
    commandParser;
    intentPipeline;
    constructor(identity, commandParser, intentPipeline) {
        this.identity = identity;
        this.commandParser = commandParser;
        this.intentPipeline = intentPipeline;
    }
    async handle(msg, tenantId) {
        const { userId, sessionId } = await this.identity.resolve(msg.platform, msg.platformUserId, tenantId);
        // Slash commands → TaskInterventionGateway (not new tasks)
        if (msg.text.trim().startsWith('/')) {
            await this.commandParser.parse(msg, tenantId, userId);
            return;
        }
        const replyTarget = {
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
exports.ChannelRouter = ChannelRouter;
//# sourceMappingURL=ChannelRouter.js.map