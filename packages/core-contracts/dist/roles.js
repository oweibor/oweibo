"use strict";
// DONE: Phase A.10 — canonical CanonicalRole enum + const array
// Single authoritative source for the 4 roles the prompt registry serves.
// All other code must import from here; string literals are banned by CI gate.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANONICAL_ROLES = void 0;
/**
 * CANONICAL_ROLES — immutable ordered list of all canonical roles.
 * Iterate over this instead of hardcoding string literals.
 */
exports.CANONICAL_ROLES = [
    'architect',
    'executor',
    'reviewer',
    'decomposer',
];
//# sourceMappingURL=roles.js.map