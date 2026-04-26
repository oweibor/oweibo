import type { IModuleManifest } from './IModuleManifest.js';
/**
 * IScopedEventBus — the event bus interface available to factory modules.
 * Wraps the raw EventEmitter with manifest-based access control.
 *
 * Modules may only emit events listed in manifest.emits and subscribe to
 * events listed in manifest.consumes. Violations throw UndeclaredSubscriptionError,
 * which surfaces as a build-time gate failure in CI.
 */
export interface IScopedEventBus {
    /**
     * Emit a domain event. Throws UndeclaredSubscriptionError if eventType is
     * not declared in manifest.emits.
     */
    emit<T>(eventType: string, payload: T): void;
    /**
     * Subscribe to a domain event. Throws UndeclaredSubscriptionError if eventType
     * is not declared in manifest.consumes.
     * @returns Unsubscribe function.
     */
    on<T>(eventType: string, handler: (payload: T) => void | Promise<void>): () => void;
}
/**
 * Thrown by ScopedEventBus when a module emits or subscribes to an event type
 * not declared in its IModuleManifest. Programming error — should never occur
 * in a passing test suite.
 */
export declare class UndeclaredSubscriptionError extends Error {
    readonly eventType: string;
    readonly moduleId: string;
    constructor(eventType: string, moduleId: string);
}
export type { IModuleManifest };
//# sourceMappingURL=IScopedEventBus.d.ts.map