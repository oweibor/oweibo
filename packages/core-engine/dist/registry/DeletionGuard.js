"use strict";
// packages/core-engine/src/registry/DeletionGuard.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateModuleDeletion = validateModuleDeletion;
async function validateModuleDeletion(moduleId, ctx) {
    const conflicts = [];
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
//# sourceMappingURL=DeletionGuard.js.map