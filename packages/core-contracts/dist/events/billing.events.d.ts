/**
 * Billing domain events (§3.5).
 * Schema versioning enables backward-compatible evolution without breaking consumers.
 *
 * Modules declare consumed/emitted versions explicitly in their manifest:
 *   consumes: ['billing:invoice.created@v1']
 *   emits:    ['billing:invoice.created@v2']
 */
export interface InvoiceCreatedEventV1 {
    readonly type: 'billing:invoice.created';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly invoiceId: string;
        readonly amount: number;
        readonly tenantId: string;
    };
}
export interface InvoiceCreatedEventV2 {
    readonly type: 'billing:invoice.created';
    readonly schemaVersion: '2';
    readonly payload: {
        readonly invoiceId: string;
        readonly amount: number;
        readonly currency: string;
        readonly tenantId: string;
    };
}
export interface PaymentCapturedEventV1 {
    readonly type: 'billing:payment.captured';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly invoiceId: string;
        readonly paymentId: string;
        readonly amount: number;
        readonly currency: string;
        readonly provider: 'paystack' | 'flutterwave' | 'mobile_money' | 'stripe';
        readonly tenantId: string;
        readonly capturedAt: string;
    };
}
/**
 * Migration adapter — modules still consuming v1 get auto-upgraded.
 * Wire this adapter in the ScopedEventBus middleware for backward compatibility.
 */
export declare function upgradeInvoiceCreatedV1toV2(event: InvoiceCreatedEventV1): InvoiceCreatedEventV2;
//# sourceMappingURL=billing.events.d.ts.map