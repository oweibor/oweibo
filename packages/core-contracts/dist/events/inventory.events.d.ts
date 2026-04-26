/**
 * Inventory domain events.
 * Placeholder — full schema defined when module-inventory is implemented.
 */
export interface InventoryStockUpdatedEventV1 {
    readonly type: 'inventory:stock.updated';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly productId: string;
        readonly sku: string;
        readonly previousQuantity: number;
        readonly newQuantity: number;
        readonly warehouseId: string;
        readonly tenantId: string;
        readonly updatedAt: string;
    };
}
export interface InventoryLowStockAlertEventV1 {
    readonly type: 'inventory:stock.low';
    readonly schemaVersion: '1';
    readonly payload: {
        readonly productId: string;
        readonly sku: string;
        readonly currentQuantity: number;
        readonly reorderThreshold: number;
        readonly tenantId: string;
        readonly alertedAt: string;
    };
}
//# sourceMappingURL=inventory.events.d.ts.map