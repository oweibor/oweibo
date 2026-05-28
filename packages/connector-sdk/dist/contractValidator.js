"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBundle = validateBundle;
function validateBundle(bundle) {
    const v = [];
    const { spec, catalogEntry } = bundle;
    if (!spec.connectorId.match(/^[a-z][a-z0-9_-]*$/)) {
        v.push({
            path: 'spec.connectorId',
            message: `connectorId must be lowercase kebab/underscore, got ${JSON.stringify(spec.connectorId)}`,
        });
    }
    if (spec.displayName.length === 0) {
        v.push({ path: 'spec.displayName', message: 'must be non-empty' });
    }
    if (spec.catalogVersion.length === 0) {
        v.push({ path: 'spec.catalogVersion', message: 'must be non-empty' });
    }
    if (!isJsonSchemaLike(spec.credentialSchema)) {
        v.push({ path: 'spec.credentialSchema', message: 'must be a JSONSchema-like object' });
    }
    if (spec.capabilities.length === 0) {
        v.push({ path: 'spec.capabilities', message: 'at least one capability is required' });
    }
    for (const [i, cap] of spec.capabilities.entries()) {
        const base = `spec.capabilities[${i}]`;
        if (!cap.capabilityId.match(/^[a-z][a-z0-9_-]*$/)) {
            v.push({ path: `${base}.capabilityId`, message: 'must be lowercase kebab/underscore' });
        }
        if (cap.summary.length === 0) {
            v.push({ path: `${base}.summary`, message: 'must be non-empty' });
        }
        if (!isJsonSchemaLike(cap.inputSchema)) {
            v.push({ path: `${base}.inputSchema`, message: 'must be a JSONSchema-like object' });
        }
        if (!isJsonSchemaLike(cap.outputSchema)) {
            v.push({ path: `${base}.outputSchema`, message: 'must be a JSONSchema-like object' });
        }
        if (typeof cap.invoke !== 'function') {
            v.push({ path: `${base}.invoke`, message: 'must be a function' });
        }
    }
    // Cross-check the derived catalog entry mirrors the spec.
    if (catalogEntry.connectorId !== spec.connectorId) {
        v.push({ path: 'catalogEntry.connectorId', message: 'must equal spec.connectorId' });
    }
    if (catalogEntry.capabilities.length !== spec.capabilities.length) {
        v.push({
            path: 'catalogEntry.capabilities',
            message: 'length must equal spec.capabilities.length',
        });
    }
    return { ok: v.length === 0, violations: v };
}
function isJsonSchemaLike(s) {
    if (s === null || typeof s !== 'object')
        return false;
    const obj = s;
    // Permissive: JSONSchema doesn't strictly require `type`, but the
    // common case in connector schemas does.
    return typeof obj['type'] === 'string' || typeof obj['$ref'] === 'string' || obj['properties'] !== undefined;
}
//# sourceMappingURL=contractValidator.js.map