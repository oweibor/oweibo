/**
 * NativeMessagingHost — Node-side peer of NativeMessagingBridge (v9.5.9).
 *
 * Chrome launches this host process on demand when the extension calls
 * `chrome.runtime.connectNative('com.oweibo.browser')`. Chrome speaks
 * Native Messaging over stdio:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ 4-byte little-endian uint32 length prefix                   │
 *   │ UTF-8 JSON payload                                          │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * This module is transport-neutral: it owns the framing codec and a
 * request/response correlation map, and exposes `sendAction()` for the
 * oweibo BrowserTool side plus `onInbound()` for replies from the extension.
 *
 * The host authenticates every message with HMAC-SHA256 over a canonical
 * JSON form (excluding the `hmac` field itself) using a shared token
 * established during deep-link pairing.
 */
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
export interface NativeHostMessage {
    callId: string;
    /** Host→extension: the browser action to execute. */
    action?: unknown;
    /** Host→extension: target tab id. */
    tabId?: number;
    /** Host→extension: HITL gate to open in the extension. */
    gate?: {
        gateId: string;
        type: 'dialog' | 'vision-loop';
        message: string;
    };
    /** Extension→host: successful result of a prior action. */
    result?: unknown;
    /** Extension→host: error result of a prior action. */
    error?: string;
    /** 'request' (host originates) or 'response' (extension replies). */
    direction?: 'request' | 'response';
    /** HMAC-SHA256 over the canonical JSON (excluding this field). */
    hmac?: string;
}
/** Inbound request from the extension (for example, `extension-hitl-respond`). */
export interface InboundRequest {
    callId: string;
    action: unknown;
    tabId?: number;
}
export interface NativeMessagingHostOptions {
    /** Shared secret used for HMAC on every message. Set via pairing handshake. */
    hmacToken: string;
    /** Per-call timeout in ms for outbound sendAction calls. */
    callTimeoutMs?: number;
    /** Stream the host reads framed messages from (default: process.stdin). */
    input?: Readable;
    /** Stream the host writes framed messages to (default: process.stdout). */
    output?: Writable;
    /** Optional logger. */
    logger?: {
        info: (m: string) => void;
        warn: (m: string) => void;
        error: (m: string) => void;
    };
}
export declare interface NativeMessagingHost {
    on(event: 'inbound-request', listener: (req: InboundRequest) => void): this;
    on(event: 'disconnect', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
}
/**
 * Stateful host that frames and dispatches native-messaging traffic.
 * Construct one per connected extension session.
 */
export declare class NativeMessagingHost extends EventEmitter {
    private readonly pending;
    private readonly callTimeoutMs;
    private readonly input;
    private readonly output;
    private readonly hmacToken;
    private readonly logger;
    private buf;
    private closed;
    constructor(opts: NativeMessagingHostOptions);
    /** Send an action to the extension and await its result. */
    sendAction(action: unknown, tabId: number): Promise<unknown>;
    /** Ask the extension to open a HITL gate surface in `tabId`. */
    openGate(gate: {
        gateId: string;
        type: 'dialog' | 'vision-loop';
        message: string;
    }, tabId: number): Promise<void>;
    /** Respond to an inbound request from the extension (e.g. gate resolution). */
    respond(callId: string, result: unknown, error?: string): void;
    /** Cleanly close stdio streams and reject all pending calls. */
    shutdown(reason?: string): void;
    private onData;
    private write;
    private handleMessage;
    private canonicalize;
    private sign;
    private verify;
}
//# sourceMappingURL=NativeMessagingHost.d.ts.map