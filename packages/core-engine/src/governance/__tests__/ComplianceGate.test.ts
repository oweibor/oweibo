/**
 * ComplianceGate test suite — covers both regex rules and AST deep analysis.
 *
 * Tests baseline regression protection for existing regex rules, plus AST
 * bypass scenarios that regex cannot catch.
 */
import { describe, it, expect } from '@jest/globals';
import { ComplianceGate } from '../ComplianceGate.js';
import type { ArtifactBundle, ArtifactFile } from '@oweibo/core-contracts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFile(path: string, content: string): ArtifactFile {
  return { path, content, encoding: 'utf-8', checksum: 'test' };
}

function makeBundle(files: ArtifactFile[], overrides?: Partial<ArtifactBundle>): ArtifactBundle {
  return {
    files,
    testFiles: [makeFile('test.ts', 'it("passes", () => {});')],
    dbMigrations: [],
    k8sManifests: [],
    docFiles: [],
    knowledgeArtifact: {} as ArtifactBundle['knowledgeArtifact'],
    signature: 'test-sig',
    ...overrides,
  };
}

// ─── Regex Rules (Baseline Regression) ────────────────────────────────────────

describe('ComplianceGate — Regex Rules', () => {
  const gate = new ComplianceGate({ skipAst: true });

  it('SEC-001: detects weak hash (MD5)', () => {
    const bundle = makeBundle([makeFile('crypto.ts', 'const h = md5(data);')]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'SEC-001')).toBe(true);
  });

  it('SEC-001: detects weak hash (SHA-1)', () => {
    const bundle = makeBundle([makeFile('hash.ts', 'createHash("sha1").update(x).digest();')]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'SEC-001')).toBe(true);
  });

  it('SEC-002: detects hardcoded secret', () => {
    const bundle = makeBundle([makeFile('config.ts', 'const password = "s3cr3t!123";')]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'SEC-002')).toBe(true);
  });

  it('SEC-003: detects eval()', () => {
    const bundle = makeBundle([makeFile('danger.ts', 'eval(userInput);')]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'SEC-003')).toBe(true);
  });

  it('SEC-004: detects SQL template literal injection', () => {
    const code = 'const q = `SELECT * FROM users WHERE id = ${userId}`;';
    const bundle = makeBundle([makeFile('query.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'SEC-004')).toBe(true);
  });

  it('SEC-005: detects exec with template literal', () => {
    const code = 'exec(`rm -rf ${userPath}`);';
    const bundle = makeBundle([makeFile('shell.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'SEC-005')).toBe(true);
  });

  it('SEC-006: detects console logging of secrets', () => {
    const code = 'console.log("password:", password);';
    const bundle = makeBundle([makeFile('debug.ts', code)]);
    const result = gate.check(bundle);
    // SEC-006 is 'high' severity, not 'critical' — passes by default
    expect(result.warnings.some(v => v.ruleId === 'SEC-006')).toBe(true);
  });

  it('TDD-001: flags missing test files', () => {
    const bundle = makeBundle([makeFile('app.ts', 'export const x = 1;')], {
      testFiles: [],
    });
    const result = gate.check(bundle);
    expect(result.warnings.some(v => v.ruleId === 'TDD-001')).toBe(true);
  });

  it('passes clean code', () => {
    const code = `
      import { createHash } from 'crypto';
      const hash = createHash('sha256').update(data).digest('hex');
      const key = process.env.API_KEY;
    `;
    const bundle = makeBundle([makeFile('clean.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ─── AST Bypass Scenarios ─────────────────────────────────────────────────────

describe('ComplianceGate — AST Deep Analysis', () => {
  const gate = new ComplianceGate();

  it('AST-SEC-002: catches string-concatenated secrets that bypass regex', () => {
    const code = `const password = "my" + "Secret" + "123";`;
    const bundle = makeBundle([makeFile('config.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'AST-SEC-002')).toBe(true);
  });

  it('AST-SEC-002: catches secret in property assignment that bypasses regex', () => {
    // This bypasses HARDCODED_SECRET_RE because of the concatenation on RHS
    const code = `const config = { apiKey: "hard" + "coded" };`;
    const bundle = makeBundle([makeFile('config.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'AST-SEC-002')).toBe(true);
  });

  it('AST-SEC-002: allows process.env access (no false positive)', () => {
    const code = `const password = process.env.DB_PASSWORD;`;
    const bundle = makeBundle([makeFile('config.ts', code)]);
    const result = gate.check(bundle);
    const astSecrets = result.violations.filter(v => v.ruleId === 'AST-SEC-002');
    expect(astSecrets).toHaveLength(0);
  });

  it('AST-SEC-003: catches indirect eval via bracket notation', () => {
    const code = `const fn = globalThis["eval"]; fn(code);`;
    const bundle = makeBundle([makeFile('danger.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'AST-SEC-003')).toBe(true);
  });

  it('AST-SEC-003: catches new Function() (eval equivalent)', () => {
    const code = `const fn = new Function("return this")();`;
    const bundle = makeBundle([makeFile('danger.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'AST-SEC-003')).toBe(true);
  });

  it('AST-SEC-003: catches eval aliased to variable', () => {
    const code = `const e = eval; e(untrustedInput);`;
    const bundle = makeBundle([makeFile('danger.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    // Should be caught by BOTH regex (SEC-003 for direct eval ref) and AST
    const evalViolations = result.violations.filter(v =>
      v.ruleId === 'SEC-003' || v.ruleId === 'AST-SEC-003',
    );
    expect(evalViolations.length).toBeGreaterThanOrEqual(1);
  });

  it('AST-SEC-004: catches SQL via string concatenation', () => {
    const code = `const query = "SELECT * FROM users WHERE id = " + userId;`;
    const bundle = makeBundle([makeFile('query.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'AST-SEC-004')).toBe(true);
  });

  it('AST-SEC-004: allows parameterized queries (no false positive)', () => {
    const code = `
      const query = \`SELECT * FROM users WHERE id = $1\`;
      await pool.query(query, [userId]);
    `;
    const bundle = makeBundle([makeFile('query.ts', code)]);
    const result = gate.check(bundle);
    const sqlViolations = result.violations.filter(v => v.ruleId === 'AST-SEC-004');
    expect(sqlViolations).toHaveLength(0);
  });

  it('AST-SEC-005: catches aliased child_process exec', () => {
    const code = `
      const { exec: run } = require("child_process");
      run(userInput);
    `;
    const bundle = makeBundle([makeFile('shell.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'AST-SEC-005')).toBe(true);
  });

  it('AST-SEC-005: catches import aliased exec', () => {
    const code = `
      import { exec as e } from "child_process";
      e(\`rm -rf \${userPath}\`);
    `;
    const bundle = makeBundle([makeFile('shell.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v =>
      v.ruleId === 'AST-SEC-005' || v.ruleId === 'SEC-005',
    )).toBe(true);
  });
});

// ─── Options & Configuration ──────────────────────────────────────────────────

describe('ComplianceGate — Options', () => {
  it('skipAst: true disables AST pass', () => {
    const gate = new ComplianceGate({ skipAst: true });
    // This bypass should NOT be caught with skipAst
    const code = `const password = "my" + "Secret" + "123";`;
    const bundle = makeBundle([makeFile('config.ts', code)]);
    const result = gate.check(bundle);
    // Regex won't catch string concatenation — so it should pass
    const astViolations = result.violations.filter(v => v.ruleId.startsWith('AST-'));
    expect(astViolations).toHaveLength(0);
  });

  it('skipRules works for AST rules', () => {
    const gate = new ComplianceGate({ skipRules: new Set(['AST-SEC-002']) });
    const code = `const password = "my" + "Secret" + "123";`;
    const bundle = makeBundle([makeFile('config.ts', code)]);
    const result = gate.check(bundle);
    expect(result.violations.filter(v => v.ruleId === 'AST-SEC-002')).toHaveLength(0);
  });

  it('blockOn: "high" also blocks high-severity violations', () => {
    const gate = new ComplianceGate({ blockOn: 'high', skipAst: true });
    const code = 'console.log("password:", password);';
    const bundle = makeBundle([makeFile('debug.ts', code)]);
    const result = gate.check(bundle);
    expect(result.passed).toBe(false);
    expect(result.violations.some(v => v.ruleId === 'SEC-006')).toBe(true);
  });
});

// ─── Performance ──────────────────────────────────────────────────────────────

describe('ComplianceGate — Performance', () => {
  it('processes a 20-file bundle with AST in under 5 seconds', () => {
    const gate = new ComplianceGate();
    const cleanCode = `
      import { createHash } from 'crypto';
      export function hash(data: string): string {
        return createHash('sha256').update(data).digest('hex');
      }
      export async function query(pool: any, id: string) {
        return pool.query('SELECT * FROM users WHERE id = $1', [id]);
      }
    `;
    const files = Array.from({ length: 20 }, (_, i) =>
      makeFile(`module-${i}.ts`, cleanCode),
    );
    const bundle = makeBundle(files);

    const start = performance.now();
    const result = gate.check(bundle);
    const elapsed = performance.now() - start;

    expect(result.passed).toBe(true);
    // Allow generous 5s budget for CI environments (local should be <500ms)
    expect(elapsed).toBeLessThan(5000);
  });
});
