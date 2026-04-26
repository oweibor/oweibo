"use strict";
/**
 * BrowserLogCollector — console + network log accumulator.
 * (NEW v9.5.4)
 *
 * Listeners are attached to every Page at creation time. Accumulation is controlled
 * via startCapture() / stopCapture() per session.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserLogCollector = void 0;
class BrowserLogCollector {
    consoleLogs = new Map();
    networkLog = new Map();
    capturedSince = new Map();
    isCapturing = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachToPage(page, sessionId, emitter) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page.on('console', (msg) => {
            if (!this.isCapturing.get(sessionId))
                return;
            const entry = {
                level: msg.type(),
                text: msg.text(),
                timestamp: Date.now(),
                url: msg.location().url,
                lineNumber: msg.location().lineNumber,
            };
            this.consoleLogs.get(sessionId)?.push(entry);
            emitter.emit('browser-console-entry', { sessionId, entry });
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page.on('request', (req) => {
            if (!this.isCapturing.get(sessionId))
                return;
            this.networkLog.get(sessionId)?.push({
                url: req.url(),
                method: req.method(),
                requestHeaders: req.headers(),
                requestBodySnippet: req.postData()?.slice(0, 2_000),
                timestamp: Date.now(),
            });
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page.on('response', async (res) => {
            if (!this.isCapturing.get(sessionId))
                return;
            const entry = this.networkLog
                .get(sessionId)
                ?.find((e) => e.url === res.url() && !e.status);
            if (entry) {
                entry.status = res.status();
                entry.responseHeaders = res.headers();
                try {
                    const body = await res.body();
                    entry.responseBodySnippet = body.toString('utf8').slice(0, 2_000);
                }
                catch { /* binary or network error */ }
                entry.durationMs = Date.now() - entry.timestamp;
            }
        });
    }
    startCapture(sessionId) {
        this.consoleLogs.set(sessionId, []);
        this.networkLog.set(sessionId, []);
        this.capturedSince.set(sessionId, Date.now());
        this.isCapturing.set(sessionId, true);
    }
    stopCapture(sessionId) {
        if (!this.isCapturing.get(sessionId))
            return null;
        this.isCapturing.set(sessionId, false);
        const snapshot = {
            consoleLogs: this.consoleLogs.get(sessionId) ?? [],
            networkLog: this.networkLog.get(sessionId) ?? [],
            capturedSince: this.capturedSince.get(sessionId) ?? Date.now(),
            capturedUntil: Date.now(),
        };
        this.consoleLogs.delete(sessionId);
        this.networkLog.delete(sessionId);
        this.capturedSince.delete(sessionId);
        return snapshot;
    }
    isActive(sessionId) {
        return this.isCapturing.get(sessionId) === true;
    }
    removeSession(sessionId) {
        this.consoleLogs.delete(sessionId);
        this.networkLog.delete(sessionId);
        this.capturedSince.delete(sessionId);
        this.isCapturing.delete(sessionId);
    }
}
exports.BrowserLogCollector = BrowserLogCollector;
//# sourceMappingURL=BrowserLogCollector.js.map