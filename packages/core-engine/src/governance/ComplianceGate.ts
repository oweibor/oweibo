/**
 * ComplianceGate — deterministic fintech/payment security compliance gate (§16e).
 *
 * Runs a deterministic checklist against generated ArtifactBundles before they
 * are committed to the workspace. Blocks bundles that violate critical security
 * invariants and emits structured violation reports to the audit trail.
 *
 * Designed for fintech/payment use-cases (OWASP ASVS L2, PCI-DSS v4, GDPR).
 */
import type { ArtifactBundle, ArtifactFile } from '@oweibo/core-contracts';
import { analyzeFileAst, resetAstProject } from './ast-analyzers/AstComplianceAnalyzer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ComplianceSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ComplianceViolation {
  readonly ruleId: string;
  readonly severity: ComplianceSeverity;
  readonly message: string;
  readonly filePath?: string;
  readonly evidence?: string;
}

export interface ComplianceGateResult {
  readonly passed: boolean;
  readonly violations: readonly ComplianceViolation[];
  readonly warnings: readonly ComplianceViolation[];
  readonly checkedAt: string;
  readonly summary: { critical: number; high: number; medium: number; low: number };
}

export interface ComplianceGateOptions {
  /** Block on 'critical' only, or also on 'high'. Default: 'critical'. */
  readonly blockOn?: 'critical' | 'high';
  /** Skip specific rule IDs (e.g. rules not applicable to this app). */
  readonly skipRules?: ReadonlySet<string>;
  /**
   * Audit-fix: skip the full AST analysis pass. Useful when callers
   * have already analyzed the bundle out-of-band or are running a
   * fast pre-flight check. Default: false (AST runs).
   */
  readonly skipAst?: boolean;
}

// ─── Dangerous pattern detectors ─────────────────────────────────────────────

const WEAK_HASH_RE = /\b(?:md5|sha1|sha-1)\b/i;
const HARDCODED_SECRET_RE = /(?:password|secret|api_?key|token)\s*[:=]\s*["'][^"']{6,}["']/i;
const CONSOLE_LOG_SECRET_RE = /console\.\w+\s*\([^)]*(?:password|secret|token|key)[^)]*\)/i;
const SQL_TEMPLATE_LITERAL_RE = /`[^`]*SELECT[^`]*\$\{[^}]+\}[^`]*`/i;
const EVAL_RE = /\beval\s*\(/;
const CHILD_PROCESS_EXEC_UNSANITISED_RE = /exec\s*\(\s*`[^`]*\$\{/;
const MISSING_AWAIT_ON_PRISMA_RE = /prisma\.\w+\.\w+\([^)]*\)\s*(?!\.then|;|\s*\))/; // heuristic only

// ─── Rule implementations ─────────────────────────────────────────────────────

type RuleFn = (bundle: ArtifactBundle) => ComplianceViolation[];

const RULES: ReadonlyArray<{ id: string; severity: ComplianceSeverity; fn: RuleFn }> = [
  {
    id: 'SEC-001',
    severity: 'critical',
    fn: (bundle) => {
      const violations: ComplianceViolation[] = [];
      for (const f of bundle.files) {
        if (!isCodeFile(f)) continue;
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
      const violations: ComplianceViolation[] = [];
      for (const f of bundle.files) {
        if (!isCodeFile(f)) continue;
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
      const violations: ComplianceViolation[] = [];
      for (const f of bundle.files) {
        if (!isCodeFile(f)) continue;
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
      const violations: ComplianceViolation[] = [];
      for (const f of bundle.files) {
        if (!isCodeFile(f)) continue;
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
      const violations: ComplianceViolation[] = [];
      for (const f of bundle.files) {
        if (!isCodeFile(f)) continue;
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
      const violations: ComplianceViolation[] = [];
      for (const f of bundle.files) {
        if (!isCodeFile(f)) continue;
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
      const violations: ComplianceViolation[] = [];
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
      const violations: ComplianceViolation[] = [];
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
      const violations: ComplianceViolation[] = [];
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

function isCodeFile(f: ArtifactFile): boolean {
  return /\.(ts|js|mjs|cjs|tsx|jsx|py|go|java|rb|sh|bash)$/.test(f.path);
}

function extractLine(content: string, pattern: RegExp): string {
  const lines = content.split('\n');
  for (const line of lines) {
    if (pattern.test(line)) return line.trim().slice(0, 200);
  }
  return '';
}

// ─── ComplianceGate class ─────────────────────────────────────────────────────

export class ComplianceGate {
  private readonly blockOn: 'critical' | 'high';
  private readonly skipRules: ReadonlySet<string>;
  private readonly skipAst: boolean;

  constructor(options: ComplianceGateOptions = {}) {
    this.blockOn = options.blockOn ?? 'critical';
    this.skipRules = options.skipRules ?? new Set();
    this.skipAst = options.skipAst ?? false;
  }

  /**
   * Run all compliance rules against an ArtifactBundle.
   * Returns a ComplianceGateResult indicating pass/fail and all violations.
   */
  check(bundle: ArtifactBundle): ComplianceGateResult {
    const allViolations: ComplianceViolation[] = [];

    for (const rule of RULES) {
      if (this.skipRules.has(rule.id)) continue;
      try {
        const ruleViolations = rule.fn(bundle);
        allViolations.push(...ruleViolations);
      } catch {
        // Rule errors must never crash the gate — log and continue
        allViolations.push({
          ruleId: rule.id,
          severity: 'low',
          message: `Rule ${rule.id} threw an error during evaluation`,
        });
      }
    }

    // Audit-fix (ComplianceGate AST): run ts-morph deep analysis on
    // every .ts/.tsx/.js/.jsx file in the bundle. The regex rules above
    // catch the obvious cases; AST analyzers in
    // ./ast-analyzers/AstComplianceAnalyzer.ts close the documented
    // bypass classes (string-concat secrets, indirect eval, SQL
    // concatenation, aliased exec). One try/finally to guarantee the
    // shared ts-morph Project is reset between checks. Callers can
    // opt out via { skipAst: true } when they've analyzed the bundle
    // out-of-band.
    if (!this.skipAst) try {
      const allFiles: readonly ArtifactFile[] = [
        ...bundle.files,
        ...bundle.testFiles,
      ];
      for (const file of allFiles) {
        if (this.skipRules.has('AST-SEC-002') &&
            this.skipRules.has('AST-SEC-003') &&
            this.skipRules.has('AST-SEC-004') &&
            this.skipRules.has('AST-SEC-005')) {
          break;
        }
        if (!/\.(ts|tsx|js|jsx|mts|cts)$/i.test(file.path)) continue;
        if (file.encoding !== 'utf-8') continue;
        try {
          const astViolations = analyzeFileAst(file.path, file.content);
          for (const v of astViolations) {
            if (this.skipRules.has(v.ruleId)) continue;
            allViolations.push({
              ruleId: v.ruleId,
              severity: v.severity,
              message: v.message,
              filePath: v.filePath,
              evidence: v.evidence,
            });
          }
        } catch {
          // Per-file parse failure must not crash the gate.
          allViolations.push({
            ruleId: 'AST-PARSE',
            severity: 'low',
            message: `AST analysis failed for ${file.path}`,
            filePath: file.path,
          });
        }
      }
    } finally {
      resetAstProject();
    }

    const blocking = this.blockOn === 'high'
      ? allViolations.filter(v => v.severity === 'critical' || v.severity === 'high')
      : allViolations.filter(v => v.severity === 'critical');

    const warnings = allViolations.filter(v => !blocking.includes(v));

    const summary = allViolations.reduce(
      (acc, v) => { acc[v.severity]++; return acc; },
      { critical: 0, high: 0, medium: 0, low: 0 },
    );

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
  assert(bundle: ArtifactBundle): void {
    const result = this.check(bundle);
    if (!result.passed) {
      throw new ComplianceViolationError(result);
    }
  }
}

export class ComplianceViolationError extends Error {
  readonly result: ComplianceGateResult;

  constructor(result: ComplianceGateResult) {
    const count = result.violations.length;
    const critical = result.violations.filter(v => v.severity === 'critical').length;
    super(`ComplianceGate: ${count} violation(s) found (${critical} critical). Bundle rejected.`);
    this.name = 'ComplianceViolationError';
    this.result = result;
  }
}
