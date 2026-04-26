#!/usr/bin/env node
/**
 * scripts/assert-tests-exist.js — CI gate: verify every source package has tests.
 *
 * Fails with exit code 1 if any package under packages/ has source files but
 * no test files. This enforces the TDD-First gate (§6, Principle 6) at the
 * monorepo CI level — separate from the per-bundle TDD gate in the pipeline.
 *
 * Usage:
 *   node scripts/assert-tests-exist.js
 *   node scripts/assert-tests-exist.js --skip module-export,module-compliance
 *   node scripts/assert-tests-exist.js --warn-only
 *
 * Exit codes:
 *   0 — all packages have tests (or --warn-only is set)
 *   1 — one or more packages are missing tests
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const warnOnly = args.includes('--warn-only');
const skipArg  = args.find(a => a.startsWith('--skip=')) ?? args[args.indexOf('--skip') + 1];
const skipSet  = new Set(
  skipArg ? (skipArg.startsWith('--skip=') ? skipArg.slice(7) : skipArg).split(',').map(s => s.trim()) : [],
);

// ─── Config ───────────────────────────────────────────────────────────────────

const PACKAGES_DIR = path.join(__dirname, '..', 'packages');

/** Glob patterns that identify source files (not tests, not config) */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/** Patterns that identify test files */
const TEST_PATTERNS = [
  /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/,
  /__tests__\//,
  /\.test$/,
];

/** Directories to ignore when walking the source tree */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', '.cache']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively collect all files under a directory.
 * @paramdir
 * @param[result]
 * @returnsabsolute file paths
 */
function walk(dir, result = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, result);
    } else if (entry.isFile()) {
      result.push(full);
    }
  }
  return result;
}

function isSourceFile(filePath) {
  const ext = path.extname(filePath);
  if (!SOURCE_EXTENSIONS.has(ext)) return false;
  // Exclude config files at package root level
  const base = path.basename(filePath);
  if (/^(jest|babel|webpack|rollup|vite|tsup)\.config\.(ts|js|mjs)$/.test(base)) return false;
  return true;
}

function isTestFile(filePath) {
  return TEST_PATTERNS.some(p => p.test(filePath));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(PACKAGES_DIR)) {
    console.error(`[assert-tests-exist] packages/ directory not found at ${PACKAGES_DIR}`);
    process.exit(1);
  }

  const packages = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  const failures = [];
  const skipped  = [];
  const passing  = [];

  for (const pkgName of packages) {
    if (skipSet.has(pkgName)) {
      skipped.push(pkgName);
      continue;
    }

    const pkgDir = path.join(PACKAGES_DIR, pkgName);
    const srcDir = path.join(pkgDir, 'src');

    // Only check packages that have a src/ directory
    if (!fs.existsSync(srcDir)) continue;

    const allFiles   = walk(srcDir);
    const sourceFiles = allFiles.filter(f => isSourceFile(f) && !isTestFile(f));
    const testFiles   = allFiles.filter(f => isTestFile(f));

    if (sourceFiles.length === 0) {
      // Package has no source files — skip (e.g. pure config packages)
      continue;
    }

    if (testFiles.length === 0) {
      failures.push({
        package: pkgName,
        sourceCount: sourceFiles.length,
        sources: sourceFiles.slice(0, 3).map(f => path.relative(PACKAGES_DIR, f)),
      });
    } else {
      passing.push({ package: pkgName, sourceCount: sourceFiles.length, testCount: testFiles.length });
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────

  const ok  = '\x1b[32m✓\x1b[0m';
  const err = '\x1b[31m✗\x1b[0m';
  const wrn = '\x1b[33m⚠\x1b[0m';

  console.log('\n[assert-tests-exist] oweibo TDD gate — package test coverage check\n');

  for (const p of passing) {
    console.log(`  ${ok} ${p.package.padEnd(35)} ${p.sourceCount} src file(s)  ${p.testCount} test file(s)`);
  }

  for (const s of skipped) {
    console.log(`  ${wrn} ${s.padEnd(35)} (skipped)`);
  }

  if (failures.length === 0) {
    console.log(`\n${ok} All ${passing.length} package(s) have tests. Gate passed.\n`);
    process.exit(0);
  }

  console.log('');
  for (const f of failures) {
    const level = warnOnly ? wrn : err;
    console.error(`  ${level} ${f.package.padEnd(35)} ${f.sourceCount} src file(s)  0 test files`);
    for (const s of f.sources) {
      console.error(`      Source: ${s}`);
    }
  }

  const noun  = failures.length === 1 ? 'package' : 'packages';
  const label = failures.map(f => f.package).join(', ');

  if (warnOnly) {
    console.warn(`\n${wrn} Warning: ${failures.length} ${noun} missing tests: ${label}`);
    console.warn('  Gate passed (--warn-only mode).\n');
    process.exit(0);
  }

  console.error(`\n${err} ${failures.length} ${noun} missing tests: ${label}`);
  console.error('  Add at least one test file to each package to pass the TDD gate.');
  console.error('  Use --warn-only to demote this to a warning.\n');
  process.exit(1);
}

main();

export {};
