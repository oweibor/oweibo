"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComplianceViolationError = exports.ComplianceGate = void 0;
// ─── Dangerous pattern detectors ─────────────────────────────────────────────
const WEAK_HASH_RE = /\b(?:md5|sha1|sha-1)\b/i;
const HARDCODED_SECRET_RE = /(?:password|secret|api_?key|token)\s*[:=]\s*["'][^"']{6,}["']/i;
const CONSOLE_LOG_SECRET_RE = /console\.\w+\s*\([^)]*(?:password|secret|token|key)[^)]*\)/i;
const SQL_TEMPLATE_LITERAL_RE = /`[^`]*SELECT[^`]*\$\{[^}]+\}[^`]*`/i;
const EVAL_RE = /\beval\s*\(/;
const CHILD_PROCESS_EXEC_UNSANITISED_RE = /exec\s*\(\s*`[^`]*\$\{/;
const MISSING_AWAIT_ON_PRISMA_RE = /prisma\.\w+\.\w+\([^)]*\)\s*(?!\.then|;|\s*\))/; // heuristic only
const RULES = [
    {
        id: 'SEC-001',
        severity: 'critical',
        fn: (bundle) => {
            const violations = [];
            for (const f of bundle.files) {
                if (!isCodeFile(f))
                    continue;
                if (WEAK_HASH_RE.test(f.content)) {
                    violations.push({
                        ruleId: 'SEC-001',
                        severity: 'critical',
                        message: 'Weak hash algorithm (MD5 or SHA-1) detected — use SHA-256 or stronger',
                        filePath: f.path,
                        evidence: extractLine(f.content, WEAK_HASH_RE),
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'SEC-002',
        severity: 'critical',
        fn: (bundle) => {
            const violations = [];
            for (const f of bundle.files) {
                if (!isCodeFile(f))
                    continue;
                if (HARDCODED_SECRET_RE.test(f.content)) {
                    violations.push({
                        ruleId: 'SEC-002',
                        severity: 'critical',
                        message: 'Hardcoded secret or credential detected — use environment variables or Vault',
                        filePath: f.path,
                        evidence: '[redacted for security]',
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'SEC-003',
        severity: 'critical',
        fn: (bundle) => {
            const violations = [];
            for (const f of bundle.files) {
                if (!isCodeFile(f))
                    continue;
                if (EVAL_RE.test(f.content)) {
                    violations.push({
                        ruleId: 'SEC-003',
                        severity: 'critical',
                        message: 'Use of eval() detected — prohibited (OWASP ASVS V5.2.4, CWE-95)',
                        filePath: f.path,
                        evidence: extractLine(f.content, EVAL_RE),
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'SEC-004',
        severity: 'critical',
        fn: (bundle) => {
            const violations = [];
            for (const f of bundle.files) {
                if (!isCodeFile(f))
                    continue;
                if (SQL_TEMPLATE_LITERAL_RE.test(f.content)) {
                    violations.push({
                        ruleId: 'SEC-004',
                        severity: 'critical',
                        message: 'Possible SQL injection via template literal — use parameterized queries (Prisma) instead',
                        filePath: f.path,
                        evidence: extractLine(f.content, SQL_TEMPLATE_LITERAL_RE),
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'SEC-005',
        severity: 'critical',
        fn: (bundle) => {
            const violations = [];
            for (const f of bundle.files) {
                if (!isCodeFile(f))
                    continue;
                if (CHILD_PROCESS_EXEC_UNSANITISED_RE.test(f.content)) {
                    violations.push({
                        ruleId: 'SEC-005',
                        severity: 'critical',
                        message: 'Possible command injection via exec() with template literal — sanitise user input or use execFile()',
                        filePath: f.path,
                        evidence: extractLine(f.content, CHILD_PROCESS_EXEC_UNSANITISED_RE),
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'SEC-006',
        severity: 'high',
        fn: (bundle) => {
            const violations = [];
            for (const f of bundle.files) {
                if (!isCodeFile(f))
                    continue;
                if (CONSOLE_LOG_SECRET_RE.test(f.content)) {
                    violations.push({
                        ruleId: 'SEC-006',
                        severity: 'high',
                        message: 'Potential secret logging via console — use a PII-scrubbing logger',
                        filePath: f.path,
                        evidence: extractLine(f.content, CONSOLE_LOG_SECRET_RE),
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'TDD-001',
        severity: 'high',
        fn: (bundle) => {
            if (bundle.testFiles.length === 0) {
                return [{
                        ruleId: 'TDD-001',
                        severity: 'high',
                        message: 'No test files present in bundle — TDD gate requires at least one contract test',
                    }];
            }
            return [];
        },
    },
    {
        id: 'SIGN-001',
        severity: 'high',
        fn: (bundle) => {
            if (!bundle.signature) {
                return [{
                        ruleId: 'SIGN-001',
                        severity: 'high',
                        message: 'Bundle signature is missing — run the signing step before deployment',
                    }];
            }
            return [];
        },
    },
    {
        id: 'K8S-001',
        severity: 'medium',
        fn: (bundle) => {
            const violations = [];
            for (const m of bundle.k8sManifests ?? []) {
                // Warn if privileged containers are requested
                if (/privileged:\s*true/.test(m.content)) {
                    violations.push({
                        ruleId: 'K8S-001',
                        severity: 'medium',
                        message: 'K8s manifest requests privileged container — remove unless absolutely required',
                        filePath: m.path,
                        evidence: extractLine(m.content, /privileged:\s*true/),
                    });
                }
                // Warn if host network is used
                if (/hostNetwork:\s*true/.test(m.content)) {
                    violations.push({
                        ruleId: 'K8S-001',
                        severity: 'medium',
                        message: 'K8s manifest uses hostNetwork — this breaks pod network isolation',
                        filePath: m.path,
                        evidence: extractLine(m.content, /hostNetwork:\s*true/),
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'FILE-001',
        severity: 'medium',
        fn: (bundle) => {
            const violations = [];
            for (const f of bundle.files) {
                const size = Buffer.byteLength(f.content, 'utf-8');
                if (size > 10 * 1024 * 1024) {
                    violations.push({
                        ruleId: 'FILE-001',
                        severity: 'medium',
                        message: `Generated file exceeds 10 MB size limit (${(size / 1024 / 1024).toFixed(1)} MB)`,
                        filePath: f.path,
                    });
                }
            }
            return violations;
        },
    },
    {
        id: 'SCHEMA-001',
        severity: 'medium',
        fn: (bundle) => {
            // Warn if any migration drops a column or table without a safety comment
            const violations = [];
            for (const m of bundle.dbMigrations ?? []) {
                const dropRe = /\bDROP\s+(?:TABLE|COLUMN)\b/i;
                if (dropRe.test(m.content) && !m.content.includes('-- safe:')) {
                    violations.push({
                        ruleId: 'SCHEMA-001',
                        severity: 'medium',
                        message: 'Migration contains DROP TABLE/COLUMN without a "-- safe:" annotation — verify this is intentional',
                        filePath: m.path,
                        evidence: extractLine(m.content, dropRe),
                    });
                }
            }
            return violations;
        },
    },
];
// ─── Helpers ──────────────────────────────────────────────────────────────────
function isCodeFile(f) {
    return /\.(ts|js|mjs|cjs|tsx|jsx|py|go|java|rb|sh|bash)$/.test(f.path);
}
function extractLine(content, pattern) {
    const lines = content.split('\n');
    for (const line of lines) {
        if (pattern.test(line))
            return line.trim().slice(0, 200);
    }
    return '';
}
// ─── ComplianceGate class ─────────────────────────────────────────────────────
class ComplianceGate {
    blockOn;
    skipRules;
    constructor(options = {}) {
        this.blockOn = options.blockOn ?? 'critical';
        this.skipRules = options.skipRules ?? new Set();
    }
    /**
     * Run all compliance rules against an ArtifactBundle.
     * Returns a ComplianceGateResult indicating pass/fail and all violations.
     */
    check(bundle) {
        const allViolations = [];
        for (const rule of RULES) {
            if (this.skipRules.has(rule.id))
                continue;
            try {
                const ruleViolations = rule.fn(bundle);
                allViolations.push(...ruleViolations);
            }
            catch {
                // Rule errors must never crash the gate — log and continue
                allViolations.push({
                    ruleId: rule.id,
                    severity: 'low',
                    message: `Rule ${rule.id} threw an error during evaluation`,
                });
            }
        }
        const blocking = this.blockOn === 'high'
            ? allViolations.filter(v => v.severity === 'critical' || v.severity === 'high')
            : allViolations.filter(v => v.severity === 'critical');
        const warnings = allViolations.filter(v => !blocking.includes(v));
        const summary = allViolations.reduce((acc, v) => { acc[v.severity]++; return acc; }, { critical: 0, high: 0, medium: 0, low: 0 });
        return {
            passed: blocking.length === 0,
            violations: blocking,
            warnings,
            checkedAt: new Date().toISOString(),
            summary,
        };
    }
    /**
     * Assert that the bundle passes all compliance gates.
     * Throws a ComplianceViolationError if any blocking violations are found.
     */
    assert(bundle) {
        const result = this.check(bundle);
        if (!result.passed) {
            throw new ComplianceViolationError(result);
        }
    }
}
exports.ComplianceGate = ComplianceGate;
class ComplianceViolationError extends Error {
    result;
    constructor(result) {
        const count = result.violations.length;
        const critical = result.violations.filter(v => v.severity === 'critical').length;
        super(`ComplianceGate: ${count} violation(s) found (${critical} critical). Bundle rejected.`);
        this.name = 'ComplianceViolationError';
        this.result = result;
    }
}
exports.ComplianceViolationError = ComplianceViolationError;
//# sourceMappingURL=ComplianceGate.js.map