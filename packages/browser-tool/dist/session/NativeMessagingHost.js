"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeMessagingHost = void 0;
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
/** Size limit for a single native-messaging message (Chrome enforces 1 MB). */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/**
 * Stateful host that frames and dispatches native-messaging traffic.
 * Construct one per connected extension session.
 */
class NativeMessagingHost extends node_events_1.EventEmitter {
    pending = new Map();
    callTimeoutMs;
    input;
    output;
    hmacToken;
    logger;
    buf = Buffer.alloc(0);
    closed = false;
    constructor(opts) {
        super();
        this.hmacToken = opts.hmacToken;
        this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
        this.input = opts.input ?? process.stdin;
        this.output = opts.output ?? process.stdout;
        this.logger = opts.logger ?? {
            info: (m) => process.stderr.write(`[native-host] ${m}\n`),
            warn: (m) => process.stderr.write(`[native-host] WARN ${m}\n`),
            error: (m) => process.stderr.write(`[native-host] ERROR ${m}\n`),
        };
        this.input.on('data', (chunk) => this.onData(chunk));
        this.input.on('end', () => this.shutdown('stdin end'));
        this.input.on('error', (e) => this.emit('error', e));
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    /** Send an action to the extension and await its result. */
    async sendAction(action, tabId) {
        const callId = (0, node_crypto_1.randomUUID)();
        const payload = { callId, action, tabId, direction: 'request' };
        payload.hmac = this.sign(payload);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(callId);
                reject(new Error(`native host call timed out: ${callId}`));
            }, this.callTimeoutMs);
            this.pending.set(callId, { resolve, reject, timer });
            try {
                this.write(payload);
            }
            catch (e) {
                clearTimeout(timer);
                this.pending.delete(callId);
                reject(e);
            }
        });
    }
    /** Ask the extension to open a HITL gate surface in `tabId`. */
    async openGate(gate, tabId) {
        const callId = (0, node_crypto_1.randomUUID)();
        const payload = { callId, gate, tabId, direction: 'request' };
        payload.hmac = this.sign(payload);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(callId);
                reject(new Error(`native host gate open timed out: ${callId}`));
            }, this.callTimeoutMs);
            this.pending.set(callId, {
                resolve: () => resolve(),
                reject,
                timer,
            });
            try {
                this.write(payload);
            }
            catch (e) {
                clearTimeout(timer);
                this.pending.delete(callId);
                reject(e);
            }
        });
    }
    /** Respond to an inbound request from the extension (e.g. gate resolution). */
    respond(callId, result, error) {
        const payload = { callId, result, error, direction: 'response' };
        payload.hmac = this.sign(payload);
        this.write(payload);
    }
    /** Cleanly close stdio streams and reject all pending calls. */
    shutdown(reason = 'shutdown') {
        if (this.closed)
            return;
        this.closed = true;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error(`native host disconnected: ${reason}`));
        }
        this.pending.clear();
        this.emit('disconnect');
    }
    // ── Framing ─────────────────────────────────────────────────────────────────
    onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (this.buf.length >= 4) {
            const len = this.buf.readUInt32LE(0);
            if (len > MAX_MESSAGE_BYTES) {
                this.emit('error', new Error(`native host: oversized frame ${len}`));
                this.shutdown('oversized frame');
                return;
            }
            if (this.buf.length < 4 + len)
                return; // wait for the rest
            const body = this.buf.subarray(4, 4 + len).toString('utf8');
            this.buf = this.buf.subarray(4 + len);
            try {
                this.handleMessage(JSON.parse(body));
            }
            catch (e) {
                this.logger.error(`bad JSON frame: ${e.message}`);
            }
        }
    }
    write(msg) {
        if (this.closed)
            throw new Error('native host: closed');
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        if (body.length > MAX_MESSAGE_BYTES)
            throw new Error(`native host: outbound frame too large (${body.length} bytes)`);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length, 0);
        this.output.write(Buffer.concat([header, body]));
    }
    // ── Dispatch ────────────────────────────────────────────────────────────────
    handleMessage(msg) {
        if (!this.verify(msg)) {
            this.logger.warn(`HMAC mismatch; dropping ${msg.callId}`);
            return;
        }
        // Response to one of our outbound calls.
        if (msg.direction === 'response' || this.pending.has(msg.callId)) {
            const entry = this.pending.get(msg.callId);
            if (!entry)
                return;
            clearTimeout(entry.timer);
            this.pending.delete(msg.callId);
            if (msg.error)
                entry.reject(new Error(msg.error));
            else
                entry.resolve(msg.result);
            return;
        }
        // Extension-initiated request (e.g. extension-hitl-respond).
        if (msg.action) {
            this.emit('inbound-request', {
                callId: msg.callId,
                action: msg.action,
                tabId: msg.tabId,
            });
            return;
        }
        this.logger.warn(`unroutable message ${msg.callId}`);
    }
    // ── HMAC ────────────────────────────────────────────────────────────────────
    canonicalize(msg) {
        const { hmac: _h, ...rest } = msg;
        return JSON.stringify(rest);
    }
    sign(msg) {
        return (0, node_crypto_1.createHmac)('sha256', this.hmacToken).update(this.canonicalize(msg)).digest('base64');
    }
    verify(msg) {
        if (!msg.hmac)
            return false;
        const expected = Buffer.from(this.sign(msg), 'utf8');
        const actual = Buffer.from(msg.hmac, 'utf8');
        return expected.length === actual.length && (0, node_crypto_1.timingSafeEqual)(expected, actual);
    }
}
exports.NativeMessagingHost = NativeMessagingHost;
//# sourceMappingURL=NativeMessagingHost.js.map