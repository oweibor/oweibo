/**
 * BrowserLogCollector — console + network log accumulator.
 * (NEW v9.5.4)
 *
 * Listeners are attached to every Page at creation time. Accumulation is controlled
 * via startCapture() / stopCapture() per session.
 */
import type { BrowserLogSnapshot, IBrowserEventEmitter } from '@oweibo/core-contracts';
export declare class BrowserLogCollector {
    private readonly consoleLogs;
    private readonly networkLog;
    private readonly capturedSince;
    private readonly isCapturing;
    attachToPage(page: any, sessionId: string, emitter: IBrowserEventEmitter): void;
    startCapture(sessionId: string): void;
    stopCapture(sessionId: string): BrowserLogSnapshot | null;
    isActive(sessionId: string): boolean;
    removeSession(sessionId: string): void;
}
//# sourceMappingURL=BrowserLogCollector.d.ts.map