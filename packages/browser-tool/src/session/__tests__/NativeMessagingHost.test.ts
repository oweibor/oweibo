/**
 * NativeMessagingHost — framing + HMAC + dispatch coverage.
 *
 * Uses a pair of in-memory streams to play both sides of a Chrome native
 * messaging conversation without spawning a real subprocess.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { NativeMessagingHost, type NativeHostMessage } from '../NativeMessagingHost.js';

const TOKEN = 'a'.repeat(48);

function sign(msg: NativeHostMessage): string {
  const { hmac: _h, ...rest } = msg;
  return createHmac('sha256', TOKEN).update(JSON.stringify(rest)).digest('base64');
}

function frame(msg: NativeHostMessage): Buffer {
  msg.hmac = sign(msg);
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function readFrame(buf: Buffer): NativeHostMessage {
  const len = buf.readUInt32LE(0);
  return JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) as NativeHostMessage;
}

describe('NativeMessagingHost', () => {
  test('sendAction frames a request and resolves on matching response', async () => {
    const input  = new PassThrough();
    const output = new PassThrough();
    const host = new NativeMessagingHost({ hmacToken: TOKEN, input, output, callTimeoutMs: 1_000 });

    const sent: Buffer[] = [];
    output.on('data', (c: Buffer) => sent.push(c));

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
    const input  = new PassThrough();
    const output = new PassThrough();
    const host = new NativeMessagingHost({ hmacToken: TOKEN, input, output, callTimeoutMs: 200 });

    const inbound: unknown[] = [];
    host.on('inbound-request', (r) => inbound.push(r));

    const bad: NativeHostMessage = {
      callId: randomUUID(),
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
    const input  = new PassThrough();
    const output = new PassThrough();
    const host = new NativeMessagingHost({ hmacToken: TOKEN, input, output });

    const got = new Promise<{ callId: string; action: unknown }>((resolve) => {
      host.on('inbound-request', resolve);
    });

    const callId = randomUUID();
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
    const input  = new PassThrough();
    const output = new PassThrough();
    const host = new NativeMessagingHost({ hmacToken: TOKEN, input, output, callTimeoutMs: 30 });
    await expect(host.sendAction({ type: 'wait', ms: 1 }, 1)).rejects.toThrow(/timed out/);
    host.shutdown();
  });
});
