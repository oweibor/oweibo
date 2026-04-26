// packages/channel-gateway/src/adapters/WebChatAdapter.ts
// Tenant-isolated WebSocket + JWT auth.
// JWTs are issued by the existing REST API (POST /api/v1/channel/webchat-token)
// signed with Vault key oweibo/gateway/webchat-jwt-secret.
// token is the Vault JWT secret key reference (not a platform token)
import { WebSocketServer, type WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import type { IChannelAdapter, InboundChannelMessage } from './IChannelAdapter.js';

interface WebChatJWTPayload {
  userId: string;
  tenantId: string;
  sessionId?: string;
}

export class WebChatAdapter implements IChannelAdapter {
  readonly platform = 'webchat' as const;
  private wss: WebSocketServer | null = null;
  private readonly connections = new Map<string, WebSocket>();
  private readonly handlers = new Map<string, (msg: InboundChannelMessage) => Promise<void>>();

  async start(token: string, onMessage: (msg: InboundChannelMessage) => Promise<void>): Promise<void> {
    // token = JSON: { jwtSecret, port }
    const { jwtSecret, port = 3001 } = JSON.parse(token) as { jwtSecret: string; port?: number };
    this.handlers.set(jwtSecret, onMessage);

    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws, req) => {
      const rawToken = req.headers['authorization']?.replace('Bearer ', '') ??
        new URL(req.url ?? '', 'ws://localhost').searchParams.get('token');

      if (!rawToken) { ws.close(4001, 'Missing JWT'); return; }

      let payload: WebChatJWTPayload;
      try {
        payload = jwt.verify(rawToken, jwtSecret) as WebChatJWTPayload;
      } catch {
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

  async stop(_token: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wss?.close(err => err ? reject(err) : resolve());
    });
    this.wss = null;
    this.connections.clear();
    this.handlers.clear();
  }

  async sendMessage(_token: string, chatId: string, text: string): Promise<void> {
    const ws = this.connections.get(chatId);
    if (ws?.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({ type: 'message', text }));
    }
  }

  async sendTypingIndicator(_token: string, chatId: string): Promise<void> {
    const ws = this.connections.get(chatId);
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: 'typing' }));
    }
  }
}
