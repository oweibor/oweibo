"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CORE_ACTION_CLASSES = void 0;
exports.asExtendedActionClass = asExtendedActionClass;
exports.isCoreActionClass = isCoreActionClass;
exports.CORE_ACTION_CLASSES = new Set([
    'read.local',
    'read.external_api',
    'read.tenant_db',
    'write.local.scratch',
    'write.local.repo_nonprod',
    'write.local.repo_prod',
    'write.external_api.nonprod',
    'write.external_api.prod',
    'write.tenant_db.nonprod',
    'write.tenant_db.prod',
    'comm.internal',
    'comm.external_email',
    'comm.external_message',
    'financial.payment',
    'personnel.access_grant',
    'personnel.access_revoke',
    'irreversible.delete_resource',
    'irreversible.public_publish',
    'deploy.nonprod',
    'deploy.prod',
    'unclassified',
]);
/** Runtime validator + brand. Throws if `s` is not registered. */
function asExtendedActionClass(s, registry) {
    if (!registry.isRegistered(s)) {
        throw new Error(`Unknown extended action class: ${s}`);
    }
    return s;
}
/** Type guard used by exhaustive switches to fork on core vs extended. */
function isCoreActionClass(c) {
    return exports.CORE_ACTION_CLASSES.has(c);
}
//# sourceMappingURL=ActionClass.js.map