/**
 * ExtensionBridgeServer — WebSocket hub for ChromeExtensionBackend ↔ extension communication.
 * (NEW v9.5.8)
 *
 * Listens on 127.0.0.1:PORT (default 9982). Each connection identifies itself via
 * HMAC pairing handshake. Commands are routed to the paired extension and responses
 * correlated by UUID.
 */
import { WebSocket } from 'ws';
import type { BrowserActionResult, ExtensionBridgeCommand } from '@oweibo/core-contracts';
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
export declare class ExtensionBridgeServer {
    private readonly vault;
    private readonly logger;
    private readonly wss;
    private readonly connections;
    private readonly pending;
    private readonly pendingCmds;
    constructor(vault: IVaultClient, logger: ILogger, port?: number);
    /** Returns a fresh 6-char pairing code. Single-use; 30s TTL enforced by awaitPairedConnection. */
    generatePairingCode(_sessionId: string): string;
    /** Block until the extension pairs (or timeout). */
    awaitPairedConnection(tenantId: string, sessionId: string, timeoutMs?: number): Promise<PairedConnection>;
    send(sessionId: string, command: ExtensionBridgeCommand, timeoutMs?: number): Promise<BrowserActionResult>;
    disconnectSession(sessionId: string): void;
    getConnection(sessionId: string): PairedConnection | undefined;
    listConnections(): Array<{
        sessionId: string;
        tenantId: string;
        tabId: number;
        pairedAt: number;
    }>;
    stop(): void;
    private onConnect;
    private onMessage;
    private verifyPairing;
}
export {};
//# sourceMappingURL=ExtensionBridgeServer.d.ts.map