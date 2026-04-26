"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebChatAdapter = void 0;
// packages/channel-gateway/src/adapters/WebChatAdapter.ts
// Tenant-isolated WebSocket + JWT auth.
// JWTs are issued by the existing REST API (POST /api/v1/channel/webchat-token)
// signed with Vault key oweibo/gateway/webchat-jwt-secret.
// token is the Vault JWT secret key reference (not a platform token)
const ws_1 = require("ws");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
class WebChatAdapter {
    platform = 'webchat';
    wss = null;
    connections = new Map();
    handlers = new Map();
    async start(token, onMessage) {
        // token = JSON: { jwtSecret, port }
        const { jwtSecret, port = 3001 } = JSON.parse(token);
        this.handlers.set(jwtSecret, onMessage);
        this.wss = new ws_1.WebSocketServer({ port });
        this.wss.on('connection', (ws, req) => {
            const rawToken = req.headers['authorization']?.replace('Bearer ', '') ??
                new URL(req.url ?? '', 'ws://localhost').searchParams.get('token');
            if (!rawToken) {
                ws.close(4001, 'Missing JWT');
                return;
            }
            let payload;
            try {
                payload = jsonwebtoken_1.default.verify(rawToken, jwtSecret);
            }
            catch {
                ws.close(4003, 'Invalid JWT');
                return;
            }
            const userId = payload.userId;
            this.connections.set(userId, ws);
            ws.on('message', async (raw) => {
                const text = raw.toString();
                await onMessage({
                    platform: 'webchat',
                    botToken: token,
                    platformUserId: userId,
                    platformChatId: userId,
                    text,
                    messageId: `${Date.now()}:${userId}`,
                    timestamp: Date.now(),
                });
            });
            ws.on('close', () => {
                this.connections.delete(userId);
            });
        });
    }
    async stop(_token) {
        await new Promise((resolve, reject) => {
            this.wss?.close(err => err ? reject(err) : resolve());
        });
        this.wss = null;
        this.connections.clear();
        this.handlers.clear();
    }
    async sendMessage(_token, chatId, text) {
        const ws = this.connections.get(chatId);
        if (ws?.readyState === 1 /* OPEN */) {
            ws.send(JSON.stringify({ type: 'message', text }));
        }
    }
    async sendTypingIndicator(_token, chatId) {
        const ws = this.connections.get(chatId);
        if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: 'typing' }));
        }
    }
}
exports.WebChatAdapter = WebChatAdapter;
//# sourceMappingURL=WebChatAdapter.js.map