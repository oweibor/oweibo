#!/usr/bin/env node
'use strict';

/**
 * verify-contract-tests.js
 * Pre-commit gate: ensures every packages/module-* has at least one contract test.
 * Passes with exit 0 when no module packages exist yet (safe during bootstrap).
 */

const fs   = require('fs');
const path = require('path');

const PACKAGES_DIR = path.resolve(__dirname, '..', 'packages');

function findModulePackages() {
  if (!fs.existsSync(PACKAGES_DIR)) return [];
  return fs
    .readdirSync(PACKAGES_DIR)
    .filter((d) => d.startsWith('module-'))
    .map((d) => path.join(PACKAGES_DIR, d));
}

function hasContractTests(pkgDir) {
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (walk(path.join(dir, entry.name))) return true;
      } else if (
        entry.name.endsWith('.contract.test.ts') ||
        entry.name.endsWith('.contract.spec.ts')
      ) {
        return true;
      }
    }
    return false;
  };
  return walk(pkgDir);
}

const modulePackages = findModulePackages();

if (modulePackages.length === 0) {
  console.log('✓ No module packages found — contract test check skipped (bootstrap phase).');
  process.exit(0);
}

const missing = modulePackages.filter((p) => !hasContractTests(p));

if (missing.length > 0) {
  console.error('✗ Contract tests missing in:');
  missing.forEach((p) => console.error(`  - ${path.basename(p)}`));
  console.error('\nEvery packages/module-* must have at least one *.contract.test.ts file.');
  process.exit(1);
}

console.log(`✓ Contract tests verified for ${modulePackages.length} module package(s).`);
process.exit(0);
