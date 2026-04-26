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
export class UndeclaredSubscriptionError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly moduleId: string,
  ) {
    super(
      `[${moduleId}] attempted to emit/subscribe to undeclared event: "${eventType}". ` +
        `Add it to manifest.emits[] or manifest.consumes[] or remove the event reference.`,
    );
    this.name = 'UndeclaredSubscriptionError';
  }
}

// Suppress unused-import warning — IModuleManifest is used by the concrete ScopedEventBus impl
export type { IModuleManifest };
