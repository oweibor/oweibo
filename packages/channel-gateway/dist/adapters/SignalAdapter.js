"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalAdapter = void 0;
class SignalAdapter {
    platform = 'signal';
    pollers = new Map();
    handlers = new Map();
    async start(token, onMessage) {
        const { apiUrl, number, receiveIntervalMs = 3000 } = JSON.parse(token);
        this.handlers.set(number, onMessage);
        const poller = setInterval(async () => {
            try {
                const res = await fetch(`${apiUrl}/v1/receive/${encodeURIComponent(number)}`);
                if (!res.ok)
                    return;
                for (const msg of (await res.json())) {
                    const env = msg['envelope'];
                    const data = env?.['dataMessage'];
                    if (!data?.['message'])
                        continue;
                    await onMessage({
                        platform: 'signal',
                        botToken: token,
                        platformUserId: env?.['source'],
                        platformChatId: env?.['source'],
                        text: data['message'],
                        messageId: String(env?.['timestamp']),
                        timestamp: env?.['timestamp'],
                    });
                }
            }
            catch (e) {
                console.error('[SignalAdapter] poll error:', e);
            }
        }, receiveIntervalMs);
        this.pollers.set(number, poller);
    }
    async stop(token) {
        const { number } = JSON.parse(token);
        clearInterval(this.pollers.get(number));
        this.pollers.delete(number);
        this.handlers.delete(number);
    }
    async sendMessage(token, chatId, text) {
        const { apiUrl, number } = JSON.parse(token);
        await fetch(`${apiUrl}/v2/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, number, recipients: [chatId] }),
        });
    }
}
exports.SignalAdapter = SignalAdapter;
//# sourceMappingURL=SignalAdapter.js.map