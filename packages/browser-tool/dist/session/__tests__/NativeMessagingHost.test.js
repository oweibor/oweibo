"use strict";
/**
 * NativeMessagingHost — framing + HMAC + dispatch coverage.
 *
 * Uses a pair of in-memory streams to play both sides of a Chrome native
 * messaging conversation without spawning a real subprocess.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const NativeMessagingHost_js_1 = require("../NativeMessagingHost.js");
const TOKEN = 'a'.repeat(48);
function sign(msg) {
    const { hmac: _h, ...rest } = msg;
    return (0, node_crypto_1.createHmac)('sha256', TOKEN).update(JSON.stringify(rest)).digest('base64');
}
function frame(msg) {
    msg.hmac = sign(msg);
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
}
function readFrame(buf) {
    const len = buf.readUInt32LE(0);
    return JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
}
describe('NativeMessagingHost', () => {
    test('sendAction frames a request and resolves on matching response', async () => {
        const input = new node_stream_1.PassThrough();
        const output = new node_stream_1.PassThrough();
        const host = new NativeMessagingHost_js_1.NativeMessagingHost({ hmacToken: TOKEN, input, output, callTimeoutMs: 1_000 });
        const sent = [];
        output.on('data', (c) => sent.push(c));
        const promise = host.sendAction({ type: 'click', selector: '#go' }, 42);
        // Wait one tick so the host writes the framed request.
        await new Promise((r) => setImmediate(r));
        const outbound = readFrame(Buffer.concat(sent));
        expect(outbound.action).toEqual({ type: 'click', selector: '#go' });
        expect(outbound.tabId).toBe(42);
        expect(outbound.direction).toBe('request');
        expect(outbound.hmac).toBeDefined();
        // Reply.
        input.write(frame({
            callId: outbound.callId,
            result: { clicked: true },
            direction: 'response',
        }));
        await expect(promise).resolves.toEqual({ clicked: true });
        host.shutdown();
    });
    test('rejects messages with bad HMAC', async () => {
        const input = new node_stream_1.PassThrough();
        const output = new node_stream_1.PassThrough();
        const host = new NativeMessagingHost_js_1.NativeMessagingHost({ hmacToken: TOKEN, input, output, callTimeoutMs: 200 });
        const inbound = [];
        host.on('inbound-request', (r) => inbound.push(r));
        const bad = {
            callId: (0, node_crypto_1.randomUUID)(),
            action: { type: 'click' },
            tabId: 1,
            hmac: 'wrong',
        };
        const body = Buffer.from(JSON.stringify(bad), 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length, 0);
        input.write(Buffer.concat([header, body]));
        await new Promise((r) => setTimeout(r, 20));
        expect(inbound).toHaveLength(0);
        host.shutdown();
    });
    test('inbound-request fires for extension-initiated calls', async () => {
        const input = new node_stream_1.PassThrough();
        const output = new node_stream_1.PassThrough();
        const host = new NativeMessagingHost_js_1.NativeMessagingHost({ hmacToken: TOKEN, input, output });
        const got = new Promise((resolve) => {
            host.on('inbound-request', resolve);
        });
        const callId = (0, node_crypto_1.randomUUID)();
        input.write(frame({
            callId,
            action: { type: 'extension-hitl-respond', gateId: 'g1', accept: true },
            tabId: 7,
        }));
        const req = await got;
        expect(req.callId).toBe(callId);
        expect(req.action).toMatchObject({ type: 'extension-hitl-respond', gateId: 'g1' });
        host.shutdown();
    });
    test('sendAction times out when no response arrives', async () => {
        const input = new node_stream_1.PassThrough();
        const output = new node_stream_1.PassThrough();
        const host = new NativeMessagingHost_js_1.NativeMessagingHost({ hmacToken: TOKEN, input, output, callTimeoutMs: 30 });
        await expect(host.sendAction({ type: 'wait', ms: 1 }, 1)).rejects.toThrow(/timed out/);
        host.shutdown();
    });
});
//# sourceMappingURL=NativeMessagingHost.test.js.map