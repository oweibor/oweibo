"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscordAdapter = void 0;
// packages/channel-gateway/src/adapters/DiscordAdapter.ts
// discord.js — DM channel only
const discord_js_1 = require("discord.js");
class DiscordAdapter {
    platform = 'discord';
    clients = new Map();
    async start(token, onMessage) {
        const client = new discord_js_1.Client({
            intents: [discord_js_1.GatewayIntentBits.DirectMessages, discord_js_1.GatewayIntentBits.MessageContent],
        });
        client.on(discord_js_1.Events.MessageCreate, async (message) => {
            if (message.channel.type !== discord_js_1.ChannelType.DM || message.author.bot)
                return;
            await onMessage({
                platform: 'discord',
                botToken: token,
                platformUserId: message.author.id,
                platformChatId: message.channelId,
                text: message.content,
                messageId: message.id,
                timestamp: message.createdTimestamp,
            });
        });
        await client.login(token);
        this.clients.set(token, client);
    }
    async stop(token) {
        this.clients.get(token)?.destroy();
        this.clients.delete(token);
    }
    async sendMessage(token, chatId, text) {
        const channel = await this.clients.get(token)?.channels.fetch(chatId);
        if (channel?.isTextBased())
            await channel.send(text);
    }
    async sendTypingIndicator(token, chatId) {
        const channel = await this.clients.get(token)?.channels.fetch(chatId);
        if (channel?.isTextBased()) {
            // Discord.js DM channels expose sendTyping()
            const dmChannel = channel;
            await dmChannel.sendTyping?.();
        }
    }
}
exports.DiscordAdapter = DiscordAdapter;
//# sourceMappingURL=DiscordAdapter.js.map