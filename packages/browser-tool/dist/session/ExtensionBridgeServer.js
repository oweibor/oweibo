"use strict";
/**
 * ExtensionBridgeServer — WebSocket hub for ChromeExtensionBackend ↔ extension communication.
 * (NEW v9.5.8)
 *
 * Listens on 127.0.0.1:PORT (default 9982). Each connection identifies itself via
 * HMAC pairing handshake. Commands are routed to the paired extension and responses
 * correlated by UUID.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionBridgeServer = void 0;
const ws_1 = require("ws");
const crypto_1 = require("crypto");
class ExtensionBridgeServer {
    vault;
    logger;
    wss;
    connections = new Map();
    pending = new Map();
    pendingCmds = new Map();
    constructor(vault, logger, port = 9982) {
        this.vault = vault;
        this.logger = logger;
        this.wss = new ws_1.WebSocketServer({ host: '127.0.0.1', port });
        this.wss.on('connection', (ws) => void this.onConnect(ws));
        this.logger.info({ port }, 'ExtensionBridgeServer listening.');
    }
    /** Returns a fresh 6-char pairing code. Single-use; 30s TTL enforced by awaitPairedConnection. */
    generatePairingCode(_sessionId) {
        return (0, crypto_1.randomBytes)(3).toString('hex').toUpperCase();
    }
    /** Block until the extension pairs (or timeout). */
    awaitPairedConnection(tenantId, sessionId, timeoutMs = 30_000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(sessionId);
                reject(new Error(`Extension pairing timed out for "${sessionId}". ` +
                    'Open the Oweibo extension popup and enter the pairing code.'));
            }, timeoutMs);
            this.pending.set(sessionId, { resolve, reject, timer, tenantId });
        });
    }
    async send(sessionId, command, timeoutMs = 60_000) {
        const conn = this.connections.get(sessionId);
        if (!conn)
            throw new Error(`No extension for session "${sessionId}".`);
        conn.ws.send(JSON.stringify(command));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCmds.delete(command.id);
                reject(new Error(`Extension command timeout: ${command.action.type}.`));
            }, timeoutMs);
            this.pendingCmds.set(command.id, { resolve, reject, timer });
        });
    }
    disconnectSession(sessionId) {
        const conn = this.connections.get(sessionId);
        if (!conn)
            return;
        try {
            conn.ws.send(JSON.stringify({ type: 'session-end' }));
            conn.ws.close();
        }
        catch { /* already closed */ }
        this.connections.delete(sessionId);
    }
    getConnection(sessionId) {
        return this.connections.get(sessionId);
    }
    listConnections() {
        return [...this.connections.entries()].map(([sessionId, conn]) => ({
            sessionId,
            tenantId: conn.tenantId,
            tabId: conn.tabId,
            pairedAt: conn.pairedAt,
        }));
    }
    stop() {
        this.wss.close();
    }
    async onConnect(ws) {
        ws.once('message', async (raw) => {
            try {
                const payload = JSON.parse(raw.toString());
                await this.verifyPairing(payload);
                const conn = {
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
            }
            catch (err) {
                this.logger.warn({ err }, 'Extension pairing failed.');
                ws.close(4001, 'Pairing failed');
            }
        });
    }
    onMessage(raw) {
        try {
            const r = JSON.parse(raw);
            const p = this.pendingCmds.get(r.id);
            if (!p)
                return;
            clearTimeout(p.timer);
            this.pendingCmds.delete(r.id);
            if (r.error) {
                p.reject(new Error(r.error));
            }
            else {
                p.resolve(r.result);
            }
        }
        catch { /* malformed message */ }
    }
    async verifyPairing(payload) {
        const secret = await this.vault.read('oweibo/infra/browser/extension-pairing-secret');
        const expected = (0, crypto_1.createHmac)('sha256', secret)
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
exports.ExtensionBridgeServer = ExtensionBridgeServer;
//# sourceMappingURL=ExtensionBridgeServer.js.map