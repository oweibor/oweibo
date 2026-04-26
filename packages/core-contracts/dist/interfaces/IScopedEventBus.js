"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UndeclaredSubscriptionError = void 0;
/**
 * Thrown by ScopedEventBus when a module emits or subscribes to an event type
 * not declared in its IModuleManifest. Programming error — should never occur
 * in a passing test suite.
 */
class UndeclaredSubscriptionError extends Error {
    eventType;
    moduleId;
    constructor(eventType, moduleId) {
        super(`[${moduleId}] attempted to emit/subscribe to undeclared event: "${eventType}". ` +
            `Add it to manifest.emits[] or manifest.consumes[] or remove the event reference.`);
        this.eventType = eventType;
        this.moduleId = moduleId;
        this.name = 'UndeclaredSubscriptionError';
    }
}
exports.UndeclaredSubscriptionError = UndeclaredSubscriptionError;
//# sourceMappingURL=IScopedEventBus.js.map