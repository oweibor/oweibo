// packages/channel-gateway/src/adapters/TelegramAdapter.ts
// grammy — long-poll (dev) or webhook (prod via TELEGRAM_USE_WEBHOOK=true Vault flag)
import { Bot } from 'grammy';
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

export class TelegramAdapter implements IChannelAdapter {
  readonly platform = 'telegram' as const;
  private readonly bots = new Map<string, Bot>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    const bot = new Bot(token);

    bot.on('message:text', async (ctx) => {
      await onMessage({
        platform: 'telegram',
        botToken: token,
        platformUserId: String(ctx.from?.id ?? ''),
        platformChatId: String(ctx.chat.id),
        text: ctx.message.text,
        messageId: String(ctx.message.message_id),
        timestamp: ctx.message.date * 1000,
      });
    });

    this.bots.set(token, bot);
    bot.start().catch(e => console.error('[TelegramAdapter]', e));
  }

  async stop(token: string): Promise<void> {
    await this.bots.get(token)?.stop();
    this.bots.delete(token);
  }

  async sendMessage(token: string, chatId: string, text: string): Promise<void> {
    await this.bots.get(token)?.api.sendMessage(Number(chatId), text, { parse_mode: 'Markdown' });
  }

  async sendTypingIndicator(token: string, chatId: string): Promise<void> {
    await this.bots.get(token)?.api.sendChatAction(Number(chatId), 'typing');
  }
}
