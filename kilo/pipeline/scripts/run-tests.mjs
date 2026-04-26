#!/usr/bin/env node
// Cross-platform test runner — discovers and runs tests/*.ts files via tsx
import { readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = resolve(__dirname, '..', 'tests');
const files = readdirSync(testsDir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'));

if (files.length === 0) {
  console.log('[test-runner] No test files found — skipping.');
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const filePath = join(testsDir, file);
  console.log(`\n▶ ${file}`);
  const result = spawnSync('tsx', [filePath], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
    shell: true,
  });
  if (result.status !== 0) {
    console.error(`✗ ${file} failed (exit ${result.status ?? 'unknown'})`);
    failed++;
  } else {
    console.log(`✓ ${file}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${files.length} test file(s) failed.`);
  process.exit(1);
}
console.log(`\n✓ All ${files.length} test files passed.`);
