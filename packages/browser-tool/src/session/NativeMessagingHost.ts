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

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

/** Size limit for a single native-messaging message (Chrome enforces 1 MB). */
const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface NativeHostMessage {
  callId: string;
  /** Host→extension: the browser action to execute. */
  action?: unknown;
  /** Host→extension: target tab id. */
  tabId?: number;
  /** Host→extension: HITL gate to open in the extension. */
  gate?: { gateId: string; type: 'dialog' | 'vision-loop'; message: string };
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

type Pending = {
  resolve: (value: unknown) => void;
  reject:  (err: Error) => void;
  timer:   NodeJS.Timeout;
};

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
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

export declare interface NativeMessagingHost {
  on(event: 'inbound-request', listener: (req: InboundRequest) => void): this;
  on(event: 'disconnect',      listener: () => void): this;
  on(event: 'error',           listener: (err: Error) => void): this;
}

/**
 * Stateful host that frames and dispatches native-messaging traffic.
 * Construct one per connected extension session.
 */
export class NativeMessagingHost extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private readonly callTimeoutMs: number;
  private readonly input:  Readable;
  private readonly output: Writable;
  private readonly hmacToken: string;
  private readonly logger: NonNullable<NativeMessagingHostOptions['logger']>;
  private buf = Buffer.alloc(0);
  private closed = false;

  constructor(opts: NativeMessagingHostOptions) {
    super();
    this.hmacToken     = opts.hmacToken;
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
    this.input         = opts.input  ?? process.stdin;
    this.output        = opts.output ?? process.stdout;
    this.logger        = opts.logger ?? {
      info:  (m) => process.stderr.write(`[native-host] ${m}\n`),
      warn:  (m) => process.stderr.write(`[native-host] WARN ${m}\n`),
      error: (m) => process.stderr.write(`[native-host] ERROR ${m}\n`),
    };

    this.input.on('data',  (chunk: Buffer) => this.onData(chunk));
    this.input.on('end',   () => this.shutdown('stdin end'));
    this.input.on('error', (e) => this.emit('error', e));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Send an action to the extension and await its result. */
  async sendAction(action: unknown, tabId: number): Promise<unknown> {
    const callId = randomUUID();
    const payload: NativeHostMessage = { callId, action, tabId, direction: 'request' };
    payload.hmac = this.sign(payload);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`native host call timed out: ${callId}`));
      }, this.callTimeoutMs);
      this.pending.set(callId, { resolve, reject, timer });

      try { this.write(payload); }
      catch (e) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(e as Error);
      }
    });
  }

  /** Ask the extension to open a HITL gate surface in `tabId`. */
  async openGate(
    gate: { gateId: string; type: 'dialog' | 'vision-loop'; message: string },
    tabId: number,
  ): Promise<void> {
    const callId = randomUUID();
    const payload: NativeHostMessage = { callId, gate, tabId, direction: 'request' };
    payload.hmac = this.sign(payload);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`native host gate open timed out: ${callId}`));
      }, this.callTimeoutMs);
      this.pending.set(callId, {
        resolve: () => resolve(),
        reject,
        timer,
      });
      try { this.write(payload); }
      catch (e) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(e as Error);
      }
    });
  }

  /** Respond to an inbound request from the extension (e.g. gate resolution). */
  respond(callId: string, result: unknown, error?: string): void {
    const payload: NativeHostMessage = { callId, result, error, direction: 'response' };
    payload.hmac = this.sign(payload);
    this.write(payload);
  }

  /** Cleanly close stdio streams and reject all pending calls. */
  shutdown(reason = 'shutdown'): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`native host disconnected: ${reason}`));
    }
    this.pending.clear();
    this.emit('disconnect');
  }

  // ── Framing ─────────────────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_MESSAGE_BYTES) {
        this.emit('error', new Error(`native host: oversized frame ${len}`));
        this.shutdown('oversized frame');
        return;
      }
      if (this.buf.length < 4 + len) return; // wait for the rest
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      try { this.handleMessage(JSON.parse(body) as NativeHostMessage); }
      catch (e) { this.logger.error(`bad JSON frame: ${(e as Error).message}`); }
    }
  }

  private write(msg: NativeHostMessage): void {
    if (this.closed) throw new Error('native host: closed');
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    if (body.length > MAX_MESSAGE_BYTES)
      throw new Error(`native host: outbound frame too large (${body.length} bytes)`);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.output.write(Buffer.concat([header, body]));
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  private handleMessage(msg: NativeHostMessage): void {
    if (!this.verify(msg)) {
      this.logger.warn(`HMAC mismatch; dropping ${msg.callId}`);
      return;
    }

    // Response to one of our outbound calls.
    if (msg.direction === 'response' || this.pending.has(msg.callId)) {
      const entry = this.pending.get(msg.callId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.callId);
      if (msg.error) entry.reject(new Error(msg.error));
      else           entry.resolve(msg.result);
      return;
    }

    // Extension-initiated request (e.g. extension-hitl-respond).
    if (msg.action) {
      this.emit('inbound-request', {
        callId: msg.callId,
        action: msg.action,
        tabId:  msg.tabId,
      } satisfies InboundRequest);
      return;
    }

    this.logger.warn(`unroutable message ${msg.callId}`);
  }

  // ── HMAC ────────────────────────────────────────────────────────────────────

  private canonicalize(msg: NativeHostMessage): string {
    const { hmac: _h, ...rest } = msg;
    return JSON.stringify(rest);
  }

  private sign(msg: NativeHostMessage): string {
    return createHmac('sha256', this.hmacToken).update(this.canonicalize(msg)).digest('base64');
  }

  private verify(msg: NativeHostMessage): boolean {
    if (!msg.hmac) return false;
    const expected = Buffer.from(this.sign(msg), 'utf8');
    const actual   = Buffer.from(msg.hmac,        'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
