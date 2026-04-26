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
export {};
//# sourceMappingURL=nativeHostEntry.d.ts.map