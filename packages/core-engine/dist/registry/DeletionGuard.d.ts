export type DeletionConflictType = 'CROSS_MODULE_REF' | 'OPEN_TRANSACTION' | 'AUDIT_REQUIREMENT';
export type DeletionSeverity = 'BLOCKING' | 'WARNING';
export interface DeletionConflict {
    type: DeletionConflictType;
    severity: DeletionSeverity;
    message: string;
    affectedModule?: string;
}
export interface DeletionValidationResult {
    moduleId: string;
    conflicts: DeletionConflict[];
    canDelete: boolean;
}
/**
 * Minimal host context required for deletion validation.
 * The full IHostContext with Prisma/DB types is not imported here to avoid
 * introducing ORM dependencies into the registry layer.
 */
export interface IDeletionHostContext {
    /** Returns active module IDs that depend on the given moduleId */
    getActiveDependents(moduleId: string): Promise<string[]>;
    /** Returns count of pending/in-flight transactions for this module */
    getPendingTransactionCount(moduleId: string): Promise<number>;
    /** Returns count of audit records still under retention for this module */
    getRetainedAuditRecordCount(moduleId: string): Promise<number>;
}
export declare function validateModuleDeletion(moduleId: string, ctx: IDeletionHostContext): Promise<DeletionValidationResult>;
//# sourceMappingURL=DeletionGuard.d.ts.map