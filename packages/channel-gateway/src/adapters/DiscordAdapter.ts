// packages/channel-gateway/src/adapters/DiscordAdapter.ts
// discord.js — DM channel only
import { Client, GatewayIntentBits, Events, ChannelType } from 'discord.js';
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class DiscordAdapter implements IChannelAdapter {
  readonly platform = 'discord' as const;
  private readonly clients = new Map<string, Client>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const client = new Client({
      intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    });

    client.on(Events.MessageCreate, async (message) => {
      if (message.channel.type !== ChannelType.DM || message.author.bot) return;
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

  async stop(token: string): Promise<void> {
    this.clients.get(token)?.destroy();
    this.clients.delete(token);
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    const channel = await this.clients.get(token)?.channels.fetch(chatId);
    if (channel?.isTextBased()) await (channel as any).send(text);
  }

  async sendTypingIndicator(token: string, chatId: string): Promise<void> {
    const channel = await this.clients.get(token)?.channels.fetch(chatId);
    if (channel?.isTextBased()) {
      // Discord.js DM channels expose sendTyping()
      const dmChannel = channel as unknown as { sendTyping?: () => Promise<void> };
      await dmChannel.sendTyping?.();
    }
  }
}
