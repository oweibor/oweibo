"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlackAdapter = void 0;
// packages/channel-gateway/src/adapters/SlackAdapter.ts
// @slack/bolt — Socket Mode
// token is JSON: { botToken, signingSecret, appToken } — stored in Vault extras
const bolt_1 = require("@slack/bolt");
class SlackAdapter {
    platform = 'slack';
    apps = new Map();
    async start(token, onMessage) {
        const { botToken, signingSecret, appToken } = JSON.parse(token);
        const app = new bolt_1.App({ token: botToken, signingSecret, socketMode: true, appToken });
        app.message(async ({ message }) => {
            if (message.subtype || !('user' in message) || !('text' in message))
                return;
            await onMessage({
                platform: 'slack',
                botToken,
                platformUserId: message.user,
                platformChatId: message.channel,
                text: message.text ?? '',
                messageId: message.ts,
                timestamp: Number(message.ts) * 1000,
            });
        });
        await app.start();
        this.apps.set(botToken, app);
    }
    async stop(token) {
        const { botToken } = JSON.parse(token);
        await this.apps.get(botToken)?.stop();
        this.apps.delete(botToken);
    }
    async sendMessage(token, chatId, text) {
        const { botToken } = JSON.parse(token);
        await this.apps.get(botToken)?.client.chat.postMessage({ channel: chatId, text });
    }
}
exports.SlackAdapter = SlackAdapter;
//# sourceMappingURL=SlackAdapter.js.map