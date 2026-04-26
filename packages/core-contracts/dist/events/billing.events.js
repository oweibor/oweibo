"use strict";
/**
 * Billing domain events (§3.5).
 * Schema versioning enables backward-compatible evolution without breaking consumers.
 *
 * Modules declare consumed/emitted versions explicitly in their manifest:
 *   consumes: ['billing:invoice.created@v1']
 *   emits:    ['billing:invoice.created@v2']
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.upgradeInvoiceCreatedV1toV2 = upgradeInvoiceCreatedV1toV2;
/**
 * Migration adapter — modules still consuming v1 get auto-upgraded.
 * Wire this adapter in the ScopedEventBus middleware for backward compatibility.
 */
function upgradeInvoiceCreatedV1toV2(event) {
    return {
        ...event,
        schemaVersion: '2',
        payload: { ...event.payload, currency: 'USD' }, // sensible default
    };
}
//# sourceMappingURL=billing.events.js.map