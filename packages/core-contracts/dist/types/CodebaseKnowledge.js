"use strict";
/**
 * CodebaseKnowledge — universal knowledge schema for the autonomous doc-generator.
 *
 * Design notes:
 *   - Intentionally separate from ModuleKnowledge. ModuleKnowledge is tightly
 *     coupled to ArtifactBundle and factory swarm outputs. CodebaseKnowledge
 *     is a superset designed for arbitrary codebases with no factory context.
 *   - A toModuleKnowledge() adapter bridges them for the factory-bridge case.
 *   - All fields are readonly: this type is built once by CodebaseAnalyzer and
 *     consumed read-only by every rendering template.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalysisWarningCode = void 0;
// ─── Warning codes (A7, v10.3 + B-series v10.4 + C-series v10.5) ─────────────
exports.AnalysisWarningCode = {
    // Analysis phase
    PYTHON_NO_AST: 'PYTHON_NO_AST',
    PYTHON_SUBPROCESS_CRASH: 'PYTHON_SUBPROCESS_CRASH',
    PYTHON_TIMEOUT: 'PYTHON_TIMEOUT',
    CIL_UNAVAILABLE: 'CIL_UNAVAILABLE',
    FILE_TOO_LARGE: 'FILE_TOO_LARGE',
    MAX_FILES_EXCEEDED: 'MAX_FILES_EXCEEDED',
    MAX_DEPTH_EXCEEDED: 'MAX_DEPTH_EXCEEDED',
    SYMLINK_LOOP: 'SYMLINK_LOOP',
    BINARY_FILE_SKIPPED: 'BINARY_FILE_SKIPPED',
    // LLM phase
    LLM_BUDGET_EXHAUSTED: 'LLM_BUDGET_EXHAUSTED',
    LLM_TIMEOUT: 'LLM_TIMEOUT',
    LLM_RESPONSE_INVALID: 'LLM_RESPONSE_INVALID',
    // Dependency phase
    LICENSE_UNRESOLVED: 'LICENSE_UNRESOLVED',
    LOCKFILE_NOT_FOUND: 'LOCKFILE_NOT_FOUND',
    LOCKFILE_PARSE_ERROR: 'LOCKFILE_PARSE_ERROR',
    // Rendering phase
    TEMPLATE_NOT_APPLICABLE: 'TEMPLATE_NOT_APPLICABLE',
    TEMPLATE_DEGRADED: 'TEMPLATE_DEGRADED',
    CROSS_REF_BROKEN: 'CROSS_REF_BROKEN',
    MERMAID_PARSE_ERROR: 'MERMAID_PARSE_ERROR',
    SECRET_DETECTED: 'SECRET_DETECTED',
    SECRET_ENTROPY_FLAGGED: 'SECRET_ENTROPY_FLAGGED',
    COVERAGE_BELOW_THRESHOLD: 'COVERAGE_BELOW_THRESHOLD',
    ADR_NAMESPACE_VIOLATION: 'ADR_NAMESPACE_VIOLATION',
    OVER_CAP_USAGE: 'OVER_CAP_USAGE',
    // Cache / backend (C5, v10.5)
    CACHE_BACKEND_FALLBACK: 'CACHE_BACKEND_FALLBACK',
    CACHE_BACKEND_NULL: 'CACHE_BACKEND_NULL',
    // Security (C6, C12, v10.5)
    ZIP_PATH_VIOLATION: 'ZIP_PATH_VIOLATION',
    GLOB_PATTERN_INVALID: 'GLOB_PATTERN_INVALID',
    // Worker / queue (C1–C4, v10.5)
    WORKER_LOST: 'WORKER_LOST',
    SUBPROCESS_POOL_TIMEOUT: 'SUBPROCESS_POOL_TIMEOUT',
    // Concurrency / quota (C2, C14, v10.5)
    QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
    // Cache lifecycle
    LEGACY_CACHE_ARCHIVED: 'LEGACY_CACHE_ARCHIVED',
    CACHE_SCHEMA_MISMATCH: 'CACHE_SCHEMA_MISMATCH',
    RUN_CANCELLED: 'RUN_CANCELLED',
};
//# sourceMappingURL=CodebaseKnowledge.js.map