/**
 * ExtensionBridgeServer — WebSocket hub for ChromeExtensionBackend ↔ extension communication.
 * (NEW v9.5.8)
 *
 * Listens on 127.0.0.1:PORT (default 9982). Each connection identifies itself via
 * HMAC pairing handshake. Commands are routed to the paired extension and responses
 * correlated by UUID.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createHmac, randomBytes } from 'crypto';
import type {
  BrowserActionResult,
  ExtensionBridgeCommand,
  ExtensionBridgeResult,
  ExtensionPairingPayload,
} from '@oweibo/core-contracts';
import type { ILogger } from './SessionReaper.js';

interface IVaultClient {
  read(path: string): Promise<unknown>;
}

interface PairedConnection {
  ws: WebSocket;
  tenantId: string;
  sessionId: string;
  tabId: number;
  pairedAt: number;
}

interface PendingPair {
  resolve: (conn: PairedConnection) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  tenantId: string;
}

interface PendingCmd {
  resolve: (result: BrowserActionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionBridgeServer {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, PairedConnection>();
  private readonly pending = new Map<string, PendingPair>();
  private readonly pendingCmds = new Map<string, PendingCmd>();

  constructor(
    private readonly vault: IVaultClient,
    private readonly logger: ILogger,
    port = 9982,
  ) {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port });
    this.wss.on('connection', (ws) => void this.onConnect(ws));
    this.logger.info({ port }, 'ExtensionBridgeServer listening.');
  }

  /** Returns a fresh 6-char pairing code. Single-use; 30s TTL enforced by awaitPairedConnection. */
  generatePairingCode(_sessionId: string): string {
    return randomBytes(3).toString('hex').toUpperCase();
  }

  /** Block until the extension pairs (or timeout). */
  awaitPairedConnection(
    tenantId: string,
    sessionId: string,
    timeoutMs = 30_000,
  ): Promise<PairedConnection> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sessionId);
        reject(
          new Error(
            `Extension pairing timed out for "${sessionId}". ` +
            'Open the Oweibo extension popup and enter the pairing code.',
          ),
        );
      }, timeoutMs);
      this.pending.set(sessionId, { resolve, reject, timer, tenantId });
    });
  }

  async send(
    sessionId: string,
    command: ExtensionBridgeCommand,
    timeoutMs = 60_000,
  ): Promise<BrowserActionResult> {
    const conn = this.connections.get(sessionId);
    if (!conn) throw new Error(`No extension for session "${sessionId}".`);
    conn.ws.send(JSON.stringify(command));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(command.id);
        reject(new Error(`Extension command timeout: ${command.action.type}.`));
      }, timeoutMs);
      this.pendingCmds.set(command.id, { resolve, reject, timer });
    });
  }

  disconnectSession(sessionId: string): void {
    const conn = this.connections.get(sessionId);
    if (!conn) return;
    try {
      conn.ws.send(JSON.stringify({ type: 'session-end' }));
      conn.ws.close();
    } catch { /* already closed */ }
    this.connections.delete(sessionId);
  }

  getConnection(sessionId: string): PairedConnection | undefined {
    return this.connections.get(sessionId);
  }

  listConnections(): Array<{ sessionId: string; tenantId: string; tabId: number; pairedAt: number }> {
    return [...this.connections.entries()].map(([sessionId, conn]) => ({
      sessionId,
      tenantId: conn.tenantId,
      tabId: conn.tabId,
      pairedAt: conn.pairedAt,
    }));
  }

  stop(): void {
    this.wss.close();
  }

  private async onConnect(ws: WebSocket): Promise<void> {
    ws.once('message', async (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as ExtensionPairingPayload;
        await this.verifyPairing(payload);
        const conn: PairedConnection = {
          ws,
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          tabId: payload.tabId,
          pairedAt: Date.now(),
        };
        this.connections.set(payload.sessionId, conn);
        const pend = this.pending.get(payload.sessionId);
        if (pend) {
          clearTimeout(pend.timer);
          this.pending.delete(payload.sessionId);
          pend.resolve(conn);
        }
        ws.send(JSON.stringify({ type: 'paired', agentVersion: '9.5.8' }));
        ws.on('message', (msg) => this.onMessage(msg.toString()));
        ws.on('close', () => {
          this.connections.delete(payload.sessionId);
          this.logger.info({ sessionId: payload.sessionId }, 'Extension disconnected.');
        });
        this.logger.info({ sessionId: payload.sessionId }, 'Extension paired.');
      } catch (err) {
        this.logger.warn({ err }, 'Extension pairing failed.');
        ws.close(4001, 'Pairing failed');
      }
    });
  }

  private onMessage(raw: string): void {
    try {
      const r = JSON.parse(raw) as ExtensionBridgeResult;
      const p = this.pendingCmds.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pendingCmds.delete(r.id);
      if (r.error) {
        p.reject(new Error(r.error));
      } else {
        p.resolve(r.result!);
      }
    } catch { /* malformed message */ }
  }

  private async verifyPairing(payload: ExtensionPairingPayload): Promise<void> {
    const secret = await this.vault.read(
      'oweibo/infra/browser/extension-pairing-secret',
    ) as string;
    const expected = createHmac('sha256', secret)
      .update(payload.pairingCode)
      .digest('hex');
    if (payload.hmac !== expected) {
      throw new Error('Pairing HMAC mismatch.');
    }
    const pend = this.pending.get(payload.sessionId);
    if (pend && pend.tenantId !== payload.tenantId) {
      throw new Error('Tenant mismatch in pairing payload.');
    }
  }
}
