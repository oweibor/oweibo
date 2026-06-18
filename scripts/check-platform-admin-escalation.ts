#!/usr/bin/env tsx
/**
 * check-platform-admin-escalation.ts
 *
 * CI gate: the only legal call-site for `SET LOCAL ROLE platform_admin` is
 * packages/db/src/withTenantContext.ts. Any other occurrence is a structural
 * RLS-bypass leak — fail the build.
 *
 * The platform_admin role has BYPASSRLS, so this string is the single token
 * that grants cross-tenant authority. Restricting it to one file makes the
 * escalation grep-able and audit-friendly, and prevents drive-by additions
 * elsewhere in the codebase.
 *
 * Scope: *.ts / *.tsx / *.js / *.mjs / *.cjs under packages/, apps/, kilo/,
 * and scripts/. Skips node_modules, dist, and build artifacts.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

const ALLOWED: RegExp[] = [
  /packages[/\\]db[/\\]src[/\\]withTenantContext\.[jt]s$/,
  // Test fixtures may simulate the escalation to verify RLS behaviour.
  /__tests__[/\\].*\.[jt]s$/,
  /\.test\.[jt]s$/,
  // The gate itself references the literal string in its documentation.
  /scripts[/\\]check-platform-admin-escalation\.[jt]s$/,
];

const SCAN_DIRS = ['packages', 'apps', 'kilo', 'scripts'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'build', '.turbo', 'coverage']);

const TARGET = /SET\s+LOCAL\s+ROLE\s+platform_admin\b/i;

interface Finding {
  file: string;
  line: number;
  text: string;
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.eslintrc') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

function isAllowed(relPath: string): boolean {
  return ALLOWED.some(re => re.test(relPath));
}

function scan(file: string): Finding[] {
  const text = fs.readFileSync(file, 'utf-8');
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    if (TARGET.test(line)) {
      findings.push({ file, line: idx + 1, text: line.trim() });
    }
  });
  return findings;
}

function main(): void {
  const violations: Finding[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (isAllowed(rel)) continue;
      const findings = scan(file);
      for (const f of findings) {
        violations.push({ ...f, file: rel });
      }
    }
  }

  if (violations.length === 0) {
    console.log('✓ check-platform-admin-escalation: no unauthorized `SET LOCAL ROLE platform_admin` call-sites.');
    process.exit(0);
  }

  console.error('✗ check-platform-admin-escalation: unauthorized platform_admin escalation detected.');
  console.error('');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error('');
  console.error('The platform_admin role has BYPASSRLS. The only legal escalation site is');
  console.error('packages/db/src/withTenantContext.ts. Use withTenantContext({...scopes:[\'platform:tenants:write\']})');
  console.error('to reach platform-admin authority from application code.');
  process.exit(1);
}

main();
