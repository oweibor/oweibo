"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IRCAdapter = void 0;
// packages/channel-gateway/src/adapters/IRCAdapter.ts
// node-irc — NickServ-aware. Falls back to ephemeral UUID nick for unidentified users.
// token is JSON: { server, port, nick, nickServPassword?, channels }
const irc = {};
const crypto_1 = require("crypto");
class IRCAdapter {
    platform = 'irc';
    clients = new Map();
    async start(token, onMessage) {
        const { server, port = 6667, nick, nickServPassword, channels = [] } = JSON.parse(token);
        // Use NickServ-identified nick when available; fall back to UUID-suffixed ephemeral nick
        const effectiveNick = nickServPassword ? nick : `${nick}-${(0, crypto_1.randomUUID)().slice(0, 8)}`;
        const client = new irc.Client(server, effectiveNick, {
            port,
            autoConnect: true,
            channels,
            secure: port === 6697,
        });
        if (nickServPassword) {
            client.addListener('registered', () => {
                client.say('NickServ', `IDENTIFY ${nickServPassword}`);
            });
        }
        client.addListener('message', async (from, to, text) => {
            // Only process private messages (DMs) to the bot
            if (to !== effectiveNick)
                return;
            await onMessage({
                platform: 'irc',
                botToken: token,
                platformUserId: from,
                platformChatId: from,
                text,
                messageId: `${Date.now()}:${from}`,
                timestamp: Date.now(),
            });
        });
        this.clients.set(token, client);
    }
    async stop(token) {
        this.clients.get(token)?.disconnect('Shutting down', () => undefined);
        this.clients.delete(token);
    }
    async sendMessage(token, chatId, text) {
        this.clients.get(token)?.say(chatId, text);
    }
}
exports.IRCAdapter = IRCAdapter;
//# sourceMappingURL=IRCAdapter.js.map