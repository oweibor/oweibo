// packages/core-engine/src/registry/DeletionGuard.ts

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

export async function validateModuleDeletion(
  moduleId: string,
  ctx: IDeletionHostContext,
): Promise<DeletionValidationResult> {
  const conflicts: DeletionConflict[] = [];

  const activeDeps = await ctx.getActiveDependents(moduleId);
  for (const dep of activeDeps) {
    conflicts.push({
      type: 'CROSS_MODULE_REF',
      severity: 'BLOCKING',
      message: `Active module "${dep}" depends on "${moduleId}". Deactivate it first.`,
      affectedModule: dep,
    });
  }

  const openTx = await ctx.getPendingTransactionCount(moduleId);
  if (openTx > 0) {
    conflicts.push({
      type: 'OPEN_TRANSACTION',
      severity: 'BLOCKING',
      message: `${openTx} pending transactions for "${moduleId}". Drain queue before deletion.`,
    });
  }

  const auditRecords = await ctx.getRetainedAuditRecordCount(moduleId);
  if (auditRecords > 0) {
    conflicts.push({
      type: 'AUDIT_REQUIREMENT',
      severity: 'WARNING',
      message: `${auditRecords} audit records for "${moduleId}" are still under retention policy.`,
    });
  }

  const canDelete = !conflicts.some(c => c.severity === 'BLOCKING');
  return { moduleId, conflicts, canDelete };
}
