"use strict";
/**
 * nativeHostEntry — Standalone Node entry point launched by Chrome via the
 * native messaging host manifest. Chrome spawns this process every time the
 * paired extension calls `chrome.runtime.connectNative('com.oweibo.browser')`
 * and tears it down on disconnect.
 *
 * Responsibilities:
 *   1. Read the shared HMAC token from `OWEIBO_NATIVE_TOKEN` (set by the
 *      installer via the user's vault, or via the deep-link pairing flow).
 *   2. Open a `NativeMessagingHost` over stdio.
 *   3. Connect to the local oweibo daemon (Unix socket / named pipe) and
 *      forward inbound extension messages to it, plus relay outbound actions
 *      back to the extension.
 *
 * The daemon-bridging layer is intentionally narrow: this binary is *not* a
 * BrowserSessionManager. It is a transport pump that lives only as long as
 * the extension is connected. The session manager runs in the long-lived
 * oweibo daemon process.
 *
 * Run as: `node dist/cli/nativeHostEntry.js`
 *
 * NOTE: process.stdout MUST be reserved for framed messages. Anything that
 * needs to be logged goes to process.stderr.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_net_1 = require("node:net");
const NativeMessagingHost_js_1 = require("../session/NativeMessagingHost.js");
/** Default IPC endpoint where the long-running oweibo daemon listens. */
const DEFAULT_DAEMON_SOCKET = process.platform === 'win32'
    ? '\\\\.\\pipe\\oweibo-browser'
    : `${process.env['XDG_RUNTIME_DIR'] ?? '/tmp'}/oweibo-browser.sock`;
function logErr(msg) {
    process.stderr.write(`[oweibo-native-host] ${msg}\n`);
}
function readToken() {
    const t = process.env['OWEIBO_NATIVE_TOKEN'];
    if (!t || t.length < 32) {
        logErr('OWEIBO_NATIVE_TOKEN missing or too short — refusing to start');
        process.exit(2);
    }
    return t;
}
async function connectDaemon(path) {
    return new Promise((resolve, reject) => {
        const sock = (0, node_net_1.createConnection)(path);
        sock.once('connect', () => resolve(sock));
        sock.once('error', reject);
    });
}
async function main() {
    const token = readToken();
    const daemonPath = process.env['OWEIBO_DAEMON_SOCKET'] ?? DEFAULT_DAEMON_SOCKET;
    const host = new NativeMessagingHost_js_1.NativeMessagingHost({ hmacToken: token });
    // ── Daemon link ────────────────────────────────────────────────────────────
    let daemon = null;
    try {
        daemon = await connectDaemon(daemonPath);
    }
    catch (e) {
        logErr(`daemon connect failed (${daemonPath}): ${e.message}`);
        // Without a daemon we cannot service inbound requests. Exit cleanly so
        // Chrome surfaces the disconnect to the extension.
        host.shutdown('no daemon');
        process.exit(3);
    }
    // Frame daemon traffic the same way as native messaging: 4-byte LE length
    // prefix + JSON body. Keeps both sides symmetric and easy to debug.
    let dbuf = Buffer.alloc(0);
    daemon.on('data', (chunk) => {
        dbuf = Buffer.concat([dbuf, chunk]);
        while (dbuf.length >= 4) {
            const len = dbuf.readUInt32LE(0);
            if (dbuf.length < 4 + len)
                break;
            const body = dbuf.subarray(4, 4 + len).toString('utf8');
            dbuf = dbuf.subarray(4 + len);
            try {
                const msg = JSON.parse(body);
                if (msg.kind === 'action') {
                    // Forward to extension and relay the result back to the daemon.
                    host.sendAction(msg.action, msg.tabId)
                        .then((result) => sendDaemon({ kind: 'response', callId: msg.callId, result }))
                        .catch((e) => sendDaemon({ kind: 'response', callId: msg.callId, error: e.message }));
                }
                else if (msg.kind === 'gate') {
                    host.openGate(msg.gate, msg.tabId)
                        .then(() => sendDaemon({ kind: 'response', callId: msg.callId, result: { ok: true } }))
                        .catch((e) => sendDaemon({ kind: 'response', callId: msg.callId, error: e.message }));
                }
                else if (msg.kind === 'response') {
                    // Daemon answering an inbound extension request.
                    host.respond(msg.callId, msg.result, msg.error);
                }
            }
            catch (e) {
                logErr(`bad daemon frame: ${e.message}`);
            }
        }
    });
    daemon.on('close', () => { logErr('daemon closed'); host.shutdown('daemon closed'); });
    daemon.on('error', (e) => logErr(`daemon error: ${e.message}`));
    function sendDaemon(obj) {
        if (!daemon || daemon.destroyed)
            return;
        const body = Buffer.from(JSON.stringify(obj), 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length, 0);
        daemon.write(Buffer.concat([header, body]));
    }
    // ── Extension → daemon pump ────────────────────────────────────────────────
    host.on('inbound-request', (req) => {
        sendDaemon({ kind: 'inbound', callId: req.callId, action: req.action, tabId: req.tabId });
    });
    host.on('disconnect', () => {
        logErr('host disconnected; exiting');
        if (daemon && !daemon.destroyed)
            daemon.end();
        setTimeout(() => process.exit(0), 50);
    });
    host.on('error', (e) => logErr(`host error: ${e.message}`));
}
main().catch((e) => { logErr(`fatal: ${e.message}`); process.exit(1); });
//# sourceMappingURL=nativeHostEntry.js.map