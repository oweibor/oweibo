"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleChatAdapter = void 0;
class GoogleChatAdapter {
    platform = 'googlechat';
    handlers = new Map();
    async start(token, onMessage) {
        const { spaceId } = JSON.parse(token);
        this.handlers.set(spaceId, onMessage);
        // Inbound via webhook edge forwarder → handleWebhook()
    }
    async stop(token) {
        const { spaceId } = JSON.parse(token);
        this.handlers.delete(spaceId);
    }
    /** Called by the webhook router for /webhooks/googlechat/{tenantId} */
    async handleWebhook(token, payload) {
        const { spaceId } = JSON.parse(token);
        const handler = this.handlers.get(spaceId);
        if (!handler)
            return;
        if (payload['type'] !== 'MESSAGE')
            return;
        const msg = payload['message'];
        const sender = msg?.['sender'];
        if (!msg || !sender)
            return;
        await handler({
            platform: 'googlechat',
            botToken: token,
            platformUserId: sender['name'],
            platformChatId: payload['space']?.['name'] ?? spaceId,
            text: (msg['argumentText'] ?? msg['text'] ?? '').trim(),
            messageId: msg['name'],
            timestamp: Date.now(),
        });
    }
    async sendMessage(token, chatId, text) {
        const { serviceAccountJson } = JSON.parse(token);
        // In production: use @googleapis/chat with service account credentials to post to the space
        // Stub — real implementation authenticates via google-auth-library
        console.info('[GoogleChatAdapter] sendMessage', { chatId, serviceAccount: !!serviceAccountJson });
        void text;
    }
}
exports.GoogleChatAdapter = GoogleChatAdapter;
//# sourceMappingURL=GoogleChatAdapter.js.map