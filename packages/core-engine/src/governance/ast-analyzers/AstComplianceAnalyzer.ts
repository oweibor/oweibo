/**
 * AstComplianceAnalyzer — ts-morph based deep analysis for security violations.
 *
 * Catches obfuscated patterns that regex rules in ComplianceGate miss:
 *   - AST-SEC-002: Hardcoded secret assignments (string concat, non-env RHS)
 *   - AST-SEC-003: Indirect eval() access (bracket notation, aliased globals)
 *   - AST-SEC-004: SQL injection via string concatenation (not just template literals)
 *   - AST-SEC-005: Command injection via aliased child_process imports
 *
 * Performance budget: ~15-50ms per file (in-memory ts-morph parse + walk).
 * Token budget impact: Zero — no LLM calls.
 *
 * @module
 */
import {
  Project,
  SyntaxKind,
  type SourceFile,
  type Node,
  type CallExpression,
  type BinaryExpression,
  type ElementAccessExpression,
} from 'ts-morph';
import type { ComplianceSeverity } from '../ComplianceGate.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AstViolation {
  readonly ruleId:    string;
  readonly severity:  ComplianceSeverity;
  readonly message:   string;
  readonly filePath:  string;
  readonly line:      number;
  readonly evidence:  string;
}

// ─── Shared constants ─────────────────────────────────────────────────────────

/** Identifiers commonly used for secrets. */
const SECRET_IDENTIFIERS = new Set([
  'password', 'passwd', 'secret', 'apikey', 'api_key', 'apiKey',
  'token', 'accesstoken', 'access_token', 'accessToken',
  'privatekey', 'private_key', 'privateKey',
  'secretkey', 'secret_key', 'secretKey',
]);

/** SQL keywords that indicate a query string. */
const SQL_KEYWORDS_RE = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/i;

/** Globals that might be used for indirect eval access. */
const EVAL_GLOBALS = new Set(['globalThis', 'window', 'global', 'self']);

/** child_process exec functions that are injection-prone. */
const EXEC_FUNCTIONS = new Set(['exec', 'execSync']);

// ─── Project cache ────────────────────────────────────────────────────────────
// Reuse a single in-memory Project across calls within a ComplianceGate.check()
// to amortise ts-morph startup cost (~5ms).

let cachedProject: Project | null = null;

function getProject(): Project {
  if (!cachedProject) {
    cachedProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
        // Don't resolve node_modules — we only care about the file's own AST
        types: [],
      },
    });
  }
  return cachedProject;
}

/** Reset the cached project (call after each ComplianceGate.check() batch). */
export function resetAstProject(): void {
  if (cachedProject) {
    for (const sf of cachedProject.getSourceFiles()) {
      cachedProject.removeSourceFile(sf);
    }
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Analyse a single TypeScript/JavaScript file for security violations using
 * ts-morph AST walking. Returns all violations found.
 *
 * @param filePath - Path of the file (for reporting)
 * @param content  - File content string
 */
export function analyzeFileAst(filePath: string, content: string): AstViolation[] {
  const project = getProject();

  // Use a unique internal path to avoid collisions
  const internalPath = `/${Date.now()}-${Math.random().toString(36).slice(2)}.ts`;
  const sourceFile = project.createSourceFile(internalPath, content, { overwrite: true });

  const violations: AstViolation[] = [];

  try {
    checkHardcodedSecrets(sourceFile, filePath, violations);
    checkIndirectEval(sourceFile, filePath, violations);
    checkSqlConcatenation(sourceFile, filePath, violations);
    checkCommandInjection(sourceFile, filePath, violations);
  } finally {
    project.removeSourceFile(sourceFile);
  }

  return violations;
}

// ─── AST-SEC-002: Hardcoded secret assignments ───────────────────────────────
// Detects: password = "literal", config.secret = "a" + "b", token: "value"
// Skips:  password = process.env.X, token = getSecret(), key = env.VAR

function checkHardcodedSecrets(
  sf: SourceFile,
  filePath: string,
  violations: AstViolation[],
): void {
  // Check variable declarations: const password = "..."
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = decl.getName().toLowerCase();
    if (!SECRET_IDENTIFIERS.has(name)) continue;

    const init = decl.getInitializer();
    if (!init) continue;

    if (isStaticStringExpression(init) && !isEnvAccess(init)) {
      violations.push({
        ruleId:   'AST-SEC-002',
        severity: 'critical',
        message:  `Hardcoded secret in variable '${decl.getName()}' — use environment variables or vault`,
        filePath,
        line:     decl.getStartLineNumber(),
        evidence: decl.getText().slice(0, 200),
      });
    }
  }

  // Check property assignments: obj.password = "..."
  for (const assign of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (assign.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;

    const left = assign.getLeft();
    const leftText = left.getText().toLowerCase();
    const matchesSecret = [...SECRET_IDENTIFIERS].some(s => leftText.endsWith(`.${s}`) || leftText === s);
    if (!matchesSecret) continue;

    const right = assign.getRight();
    if (isStaticStringExpression(right) && !isEnvAccess(right)) {
      violations.push({
        ruleId:   'AST-SEC-002',
        severity: 'critical',
        message:  `Hardcoded secret in assignment '${left.getText()}' — use environment variables or vault`,
        filePath,
        line:     assign.getStartLineNumber(),
        evidence: assign.getText().slice(0, 200),
      });
    }
  }

  // Check object literal properties: { password: "..." }
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = prop.getName().toLowerCase();
    if (!SECRET_IDENTIFIERS.has(name)) continue;

    const init = prop.getInitializer();
    if (!init) continue;

    if (isStaticStringExpression(init) && !isEnvAccess(init)) {
      violations.push({
        ruleId:   'AST-SEC-002',
        severity: 'critical',
        message:  `Hardcoded secret in property '${prop.getName()}' — use environment variables or vault`,
        filePath,
        line:     prop.getStartLineNumber(),
        evidence: prop.getText().slice(0, 200),
      });
    }
  }
}

/**
 * Check if a node resolves to a static string (literal, concatenation of
 * literals, or template literal with no expressions).
 */
function isStaticStringExpression(node: Node): boolean {
  const kind = node.getKind();

  // Direct string literal
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return true;
  }

  // String concatenation: "a" + "b"
  if (kind === SyntaxKind.BinaryExpression) {
    const bin = node as BinaryExpression;
    if (bin.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      return isStaticStringExpression(bin.getLeft()) && isStaticStringExpression(bin.getRight());
    }
  }

  // Parenthesized expression
  if (kind === SyntaxKind.ParenthesizedExpression) {
    const inner = node.getChildAtIndex(1);
    if (inner) return isStaticStringExpression(inner);
  }

  return false;
}

/** Check if a node accesses process.env, import.meta.env, or calls a vault/secret function. */
function isEnvAccess(node: Node): boolean {
  const text = node.getText();
  return (
    text.includes('process.env') ||
    text.includes('import.meta.env') ||
    text.includes('getSecret') ||
    text.includes('vault') ||
    text.includes('Vault') ||
    text.includes('env.')
  );
}

// ─── AST-SEC-003: Indirect eval access ───────────────────────────────────────
// Detects: globalThis["eval"], window["eval"], const e = eval; e(...),
//          Function("return this")(), new Function(code)

function checkIndirectEval(
  sf: SourceFile,
  filePath: string,
  violations: AstViolation[],
): void {
  // Pattern 1: bracket access on globals — globalThis["eval"], window["eval"]
  for (const access of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const expr = access as ElementAccessExpression;
    const obj = expr.getExpression().getText();
    const arg = expr.getArgumentExpression();
    if (!arg) continue;

    if (EVAL_GLOBALS.has(obj)) {
      const argText = arg.getText().replace(/['"]/g, '');
      if (argText === 'eval') {
        violations.push({
          ruleId:   'AST-SEC-003',
          severity: 'critical',
          message:  `Indirect eval() access via ${obj}["eval"] — prohibited (CWE-95)`,
          filePath,
          line:     access.getStartLineNumber(),
          evidence: access.getParent()?.getText().slice(0, 200) ?? access.getText(),
        });
      }
    }
  }

  // Pattern 2: new Function(...) constructor — equivalent to eval
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const exprText = expr.getExpression().getText();
    if (exprText === 'Function') {
      violations.push({
        ruleId:   'AST-SEC-003',
        severity: 'critical',
        message:  'new Function() is equivalent to eval() — prohibited (CWE-95)',
        filePath,
        line:     expr.getStartLineNumber(),
        evidence: expr.getText().slice(0, 200),
      });
    }
  }

  // Pattern 3: Variable aliasing — const e = eval; e(code)
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init) continue;
    if (init.getText() === 'eval' && init.getKind() === SyntaxKind.Identifier) {
      violations.push({
        ruleId:   'AST-SEC-003',
        severity: 'critical',
        message:  `eval() aliased to variable '${decl.getName()}' — prohibited (CWE-95)`,
        filePath,
        line:     decl.getStartLineNumber(),
        evidence: decl.getText().slice(0, 200),
      });
    }
  }
}

// ─── AST-SEC-004: SQL injection via string concatenation ─────────────────────
// Detects: "SELECT * FROM users WHERE id = " + userId
//          `SELECT * FROM users WHERE id = ${userId}` (template with expressions)
// Skips: queries using $1, $2 parameter placeholders

function checkSqlConcatenation(
  sf: SourceFile,
  filePath: string,
  violations: AstViolation[],
): void {
  // Pattern 1: Binary expression with SQL keyword on left + dynamic right
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.PlusToken) continue;

    const leftText = extractStringContent(bin.getLeft());
    if (!leftText || !SQL_KEYWORDS_RE.test(leftText)) continue;

    const right = bin.getRight();
    // If the right side is not a static string, it's dynamic interpolation → SQLi risk
    if (!isStaticStringExpression(right)) {
      violations.push({
        ruleId:   'AST-SEC-004',
        severity: 'critical',
        message:  'SQL query constructed via string concatenation — use parameterized queries ($1)',
        filePath,
        line:     bin.getStartLineNumber(),
        evidence: bin.getText().slice(0, 200),
      });
    }
  }

  // Pattern 2: Template literals with SQL keywords and expressions
  for (const tmpl of sf.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    const headText = tmpl.getHead().getLiteralText();
    const fullText = tmpl.getText();

    if (!SQL_KEYWORDS_RE.test(headText) && !SQL_KEYWORDS_RE.test(fullText)) continue;

    // Check if the template spans contain parameter placeholders ($1, $2)
    // If so, it's a properly parameterized query (e.g. pg tagged template)
    if (/\$\d+/.test(fullText)) continue;

    // Template has SQL keywords + expressions but no parameter placeholders
    const spans = tmpl.getTemplateSpans();
    if (spans.length > 0) {
      violations.push({
        ruleId:   'AST-SEC-004',
        severity: 'critical',
        message:  'SQL query with template literal interpolation — use parameterized queries ($1)',
        filePath,
        line:     tmpl.getStartLineNumber(),
        evidence: fullText.slice(0, 200),
      });
    }
  }
}

/** Extract the string content from a node if it's a string literal or template. */
function extractStringContent(node: Node): string | null {
  const kind = node.getKind();
  if (kind === SyntaxKind.StringLiteral) {
    return node.getText().slice(1, -1); // Remove quotes
  }
  if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getText().slice(1, -1); // Remove backticks
  }
  // Recurse into left side of concatenation
  if (kind === SyntaxKind.BinaryExpression) {
    const bin = node as BinaryExpression;
    if (bin.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      const left = extractStringContent(bin.getLeft());
      const right = extractStringContent(bin.getRight());
      if (left !== null) return left + (right ?? '');
    }
  }
  return null;
}

// ─── AST-SEC-005: Command injection via aliased child_process ────────────────
// Detects: const { exec: run } = require("child_process"); run(userInput)
//          import { exec as e } from "child_process"; e(`cmd ${var}`)

function checkCommandInjection(
  sf: SourceFile,
  filePath: string,
  violations: AstViolation[],
): void {
  // Collect all aliased imports/requires of child_process exec functions
  const execAliases = new Set<string>();

  // ES import destructuring: import { exec as e } from "child_process"
  for (const imp of sf.getImportDeclarations()) {
    const moduleSpec = imp.getModuleSpecifierValue();
    if (moduleSpec !== 'child_process' && moduleSpec !== 'node:child_process') continue;

    for (const named of imp.getNamedImports()) {
      const importedName = named.getName();
      const alias = named.getAliasNode()?.getText() ?? importedName;
      if (EXEC_FUNCTIONS.has(importedName)) {
        execAliases.add(alias);
      }
    }
  }

  // CommonJS destructuring: const { exec: run } = require("child_process")
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init) continue;

    // Check for require("child_process")
    if (init.getKind() === SyntaxKind.CallExpression) {
      const call = init as CallExpression;
      const callee = call.getExpression().getText();
      if (callee !== 'require') continue;

      const args = call.getArguments();
      if (args.length === 0) continue;
      const modName = args[0]!.getText().replace(/['"]/g, '');
      if (modName !== 'child_process' && modName !== 'node:child_process') continue;

      // Check if the declaration is destructuring
      const nameNode = decl.getNameNode();
      if (nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
        for (const element of nameNode.getDescendantsOfKind(SyntaxKind.BindingElement)) {
          const propName = element.getPropertyNameNode()?.getText() ?? element.getName();
          const alias = element.getName();
          if (EXEC_FUNCTIONS.has(propName)) {
            execAliases.add(alias);
          }
        }
      }
    }
  }

  if (execAliases.size === 0) return;

  // Now find calls to any of the aliased exec functions with dynamic arguments
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    if (!execAliases.has(callee)) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const firstArg = args[0]!;
    // Flag if first argument is a template expression or string concatenation
    // (static string literals are generally safe for exec, though still not ideal)
    const argKind = firstArg.getKind();
    if (
      argKind === SyntaxKind.TemplateExpression ||
      (argKind === SyntaxKind.BinaryExpression && !isStaticStringExpression(firstArg)) ||
      argKind === SyntaxKind.Identifier // variable — could be user input
    ) {
      violations.push({
        ruleId:   'AST-SEC-005',
        severity: 'critical',
        message:  `Command injection risk: ${callee}() called with dynamic argument — use execFile() with explicit args array`,
        filePath,
        line:     call.getStartLineNumber(),
        evidence: call.getText().slice(0, 200),
      });
    }
  }
}
