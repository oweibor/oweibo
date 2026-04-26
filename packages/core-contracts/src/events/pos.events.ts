/**
 * Point-of-Sale domain events.
 * Placeholder — full schema defined when module-pos is implemented.
 * POSSaleCompleted includes mobile_money payment method for African market support.
 */

export interface POSLineItem {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly totalPrice: number;
}

export interface POSSaleCompletedEventV1 {
  readonly type: 'pos:sale.completed';
  readonly schemaVersion: '1';
  readonly payload: {
    readonly saleId: string;
    readonly terminalId: string;
    readonly cashierId: string;
    readonly totalAmount: number;
    readonly currency: string;
    readonly lineItems: readonly POSLineItem[];
    readonly paymentMethod: 'cash' | 'card' | 'mobile_money' | 'mixed';
    readonly tenantId: string;
    readonly completedAt: string;  // ISO 8601
  };
}

export interface POSRefundIssuedEventV1 {
  readonly type: 'pos:refund.issued';
  readonly schemaVersion: '1';
  readonly payload: {
    readonly refundId: string;
    readonly originalSaleId: string;
    readonly amount: number;
    readonly currency: string;
    readonly reason: string;
    readonly tenantId: string;
    readonly issuedAt: string;  // ISO 8601
  };
}
