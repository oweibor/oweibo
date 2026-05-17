#!/usr/bin/env node
/**
 * scripts/check-role-literals.js — CI gate: ban bare CanonicalRole string literals.
 *
 * Scans TypeScript source files for string literals that are canonical role names
 * used as standalone values (e.g. 'architect', 'executor', etc.) in files that
 * are NOT the canonical definition file.
 *
 * Rationale: role names must be expressed via CanonicalRole type or CANONICAL_ROLES
 * array from @oweibo/core-contracts, not as raw string literals, so that renaming
 * a role is a single-file change with compile-time verification.
 *
 * Usage:
 *   node scripts/check-role-literals.js
 *   node scripts/check-role-literals.js --warn-only
 *
 * Exit codes:
 *   0 — no violations (or --warn-only)
 *   1 — one or more violations found
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const PACKAGES_DIR = path.join(__dirname, '..', 'packages');

const CANONICAL_ROLE_NAMES = ['architect', 'executor', 'reviewer', 'decomposer'];

// Files where role name string literals are explicitly allowed.
// Paths are relative to the repo root.
const ALLOW_LIST = new Set([
  'packages/core-contracts/src/roles.ts',
  'packages/core-engine/src/infrastructure/CohortRouter.ts',   // STABLE_V0_FALLBACKS keys
  'packages/prompt-registry/src/__tests__/integrity.test.ts',  // role iteration in test
  'packages/db/migrations/20260507_000000_phase_a_foundations.sql', // SQL seed literals
]);

const IGNORED_DIRS  = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', '.cache']);
const SOURCE_EXTS   = new Set(['.ts', '.tsx']);

// Pattern: a quoted string literal that is exactly a canonical role name,
// i.e. surrounded by quote chars with no additional chars inside.
// Matches: 'architect', "reviewer", `executor` in non-type positions.
// We look for the pattern where the role name appears as a string literal value.
const ROLE_PATTERN = new RegExp(
  `(['"\`])(${CANONICAL_ROLE_NAMES.join('|')})\\1`,
  'g',
);

// Lines that are type annotations are OK — skip lines containing ": CanonicalRole"
// or "type " or "export type" or import statements.
const SKIP_LINE_PATTERNS = [
  /^\s*(\/\/|\/\*|\*)/,               // comment lines
  /\btype\b.*=.*\|/,                  // type union definition
  /export type/,                      // type export
  /import type/,                      // type import
  /: CanonicalRole/,                  // typed as CanonicalRole
  /CANONICAL_ROLES\s*=/,              // the canonical array definition
  /STABLE_V0_FALLBACKS\s*[=:]/,       // fallback map definition
  /readonly CanonicalRole/,           // type usage
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function walk(dir, result = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return result; }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else if (SOURCE_EXTS.has(path.extname(entry.name))) result.push(full);
  }
  return result;
}

function repoRelative(absPath) {
  return path.relative(path.join(__dirname, '..'), absPath).replace(/\\/g, '/');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const warnOnly  = process.argv.includes('--warn-only');
  const violations = [];

  const allFiles = walk(PACKAGES_DIR);

  for (const filePath of allFiles) {
    const rel = repoRelative(filePath);
    if (ALLOW_LIST.has(rel)) continue;

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (SKIP_LINE_PATTERNS.some(p => p.test(line))) continue;

      let match;
      ROLE_PATTERN.lastIndex = 0;
      while ((match = ROLE_PATTERN.exec(line)) !== null) {
        violations.push({ file: rel, line: i + 1, col: match.index + 1, literal: match[0] });
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────

  const ok  = '\x1b[32m✓\x1b[0m';
  const err = '\x1b[31m✗\x1b[0m';
  const wrn = '\x1b[33m⚠\x1b[0m';

  console.log('\n[check-role-literals] Phase A.10 — CanonicalRole string literal gate\n');

  if (violations.length === 0) {
    console.log(`  ${ok} No bare role string literals found. Gate passed.\n`);
    process.exit(0);
  }

  const level = warnOnly ? wrn : err;
  for (const v of violations) {
    console.error(`  ${level} ${v.file}:${v.line}:${v.col} — bare role literal ${v.literal}`);
    console.error(`         Use CanonicalRole type or CANONICAL_ROLES from @oweibo/core-contracts`);
  }

  if (warnOnly) {
    console.warn(`\n${wrn} ${violations.length} violation(s) found (--warn-only; gate passed).\n`);
    process.exit(0);
  }

  console.error(`\n${err} ${violations.length} bare role literal(s) found. Gate failed.\n`);
  process.exit(1);
}

main();
