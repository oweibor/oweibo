"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsAppAdapter = void 0;
class WhatsAppAdapter {
    platform = 'whatsapp';
    handlers = new Map();
    async start(token, onMessage) {
        const { phoneNumberId } = JSON.parse(token);
        this.handlers.set(phoneNumberId, onMessage);
        // Inbound via webhook edge forwarder → handleWebhook()
    }
    async stop(token) {
        const { phoneNumberId } = JSON.parse(token);
        this.handlers.delete(phoneNumberId);
    }
    /** Called by the webhook router — X-Hub-Signature-256 already verified at edge */
    async handleWebhook(token, payload) {
        const { phoneNumberId } = JSON.parse(token);
        const handler = this.handlers.get(phoneNumberId);
        if (!handler)
            return;
        const entries = payload['entry'];
        const message = entries?.[0]?.['changes']?.[0]?.['value'];
        const msg = message?.['messages']?.[0];
        if (!msg || msg['type'] !== 'text')
            return;
        await handler({
            platform: 'whatsapp',
            botToken: token,
            platformUserId: msg['from'],
            platformChatId: msg['from'],
            text: msg['text']['body'] ?? '',
            messageId: msg['id'],
            timestamp: Number(msg['timestamp']) * 1000,
        });
    }
    async sendMessage(token, chatId, text) {
        const { accessToken, phoneNumberId } = JSON.parse(token);
        await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: chatId,
                type: 'text',
                text: { body: text },
            }),
        });
    }
}
exports.WhatsAppAdapter = WhatsAppAdapter;
//# sourceMappingURL=WhatsAppAdapter.js.map