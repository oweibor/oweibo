/**
 * BrowserLogCollector — console + network log accumulator.
 * (NEW v9.5.4)
 *
 * Listeners are attached to every Page at creation time. Accumulation is controlled
 * via startCapture() / stopCapture() per session.
 */

import type {
  BrowserConsoleEntry,
  BrowserLogLevel,
  BrowserLogSnapshot,
  BrowserNetworkEntry,
  IBrowserEventEmitter,
} from '@oweibo/core-contracts';

export class BrowserLogCollector {
  private readonly consoleLogs = new Map<string, BrowserConsoleEntry[]>();
  private readonly networkLog = new Map<string, BrowserNetworkEntry[]>();
  private readonly capturedSince = new Map<string, number>();
  private readonly isCapturing = new Map<string, boolean>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachToPage(page: any, sessionId: string, emitter: IBrowserEventEmitter): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.on('console', (msg: any) => {
      if (!this.isCapturing.get(sessionId)) return;
      const entry: BrowserConsoleEntry = {
        level: msg.type() as BrowserLogLevel,
        text: msg.text(),
        timestamp: Date.now(),
        url: msg.location().url,
        lineNumber: msg.location().lineNumber,
      };
      this.consoleLogs.get(sessionId)?.push(entry);
      emitter.emit('browser-console-entry', { sessionId, entry });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.on('request', (req: any) => {
      if (!this.isCapturing.get(sessionId)) return;
      this.networkLog.get(sessionId)?.push({
        url: req.url(),
        method: req.method(),
        requestHeaders: req.headers(),
        requestBodySnippet: req.postData()?.slice(0, 2_000),
        timestamp: Date.now(),
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.on('response', async (res: any) => {
      if (!this.isCapturing.get(sessionId)) return;
      const entry = this.networkLog
        .get(sessionId)
        ?.find((e) => e.url === res.url() && !e.status);
      if (entry) {
        entry.status = res.status();
        entry.responseHeaders = res.headers();
        try {
          const body = await res.body();
          entry.responseBodySnippet = (body as Buffer).toString('utf8').slice(0, 2_000);
        } catch { /* binary or network error */ }
        entry.durationMs = Date.now() - entry.timestamp;
      }
    });
  }

  startCapture(sessionId: string): void {
    this.consoleLogs.set(sessionId, []);
    this.networkLog.set(sessionId, []);
    this.capturedSince.set(sessionId, Date.now());
    this.isCapturing.set(sessionId, true);
  }

  stopCapture(sessionId: string): BrowserLogSnapshot | null {
    if (!this.isCapturing.get(sessionId)) return null;
    this.isCapturing.set(sessionId, false);
    const snapshot: BrowserLogSnapshot = {
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

  isActive(sessionId: string): boolean {
    return this.isCapturing.get(sessionId) === true;
  }

  removeSession(sessionId: string): void {
    this.consoleLogs.delete(sessionId);
    this.networkLog.delete(sessionId);
    this.capturedSince.delete(sessionId);
    this.isCapturing.delete(sessionId);
  }
}
