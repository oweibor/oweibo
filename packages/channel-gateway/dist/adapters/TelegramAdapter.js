"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramAdapter = void 0;
// packages/channel-gateway/src/adapters/TelegramAdapter.ts
// grammy — long-poll (dev) or webhook (prod via TELEGRAM_USE_WEBHOOK=true Vault flag)
const grammy_1 = require("grammy");
class TelegramAdapter {
    platform = 'telegram';
    bots = new Map();
    async start(token, onMessage) {
        const bot = new grammy_1.Bot(token);
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
    async stop(token) {
        await this.bots.get(token)?.stop();
        this.bots.delete(token);
    }
    async sendMessage(token, chatId, text) {
        await this.bots.get(token)?.api.sendMessage(Number(chatId), text, { parse_mode: 'Markdown' });
    }
    async sendTypingIndicator(token, chatId) {
        await this.bots.get(token)?.api.sendChatAction(Number(chatId), 'typing');
    }
}
exports.TelegramAdapter = TelegramAdapter;
//# sourceMappingURL=TelegramAdapter.js.map