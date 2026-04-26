// packages/browser-extension/scripts/copy-static.mjs
// Copies non-TS extension assets into build/ so `chrome://extensions → Load unpacked`
// can point directly at build/. Runs before webpack via the `build` npm script.
//
//   src/manifest.json       → build/manifest.json
//   src/pair.html           → build/pair.html
//   src/popup/popup.html    → build/popup/popup.html
//   src/icons/*             → build/icons/* (if present)

import { cp, mkdir, access, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC  = join(ROOT, 'src');
const OUT  = join(ROOT, 'build');

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function copyIfExists(from, to) {
  if (!(await exists(from))) {
    console.warn(`[copy-static] skip (missing): ${from}`);
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`[copy-static] ${from} → ${to}`);
}

await mkdir(OUT, { recursive: true });

await copyIfExists(join(SRC, 'manifest.json'),     join(OUT, 'manifest.json'));
await copyIfExists(join(SRC, 'pair.html'),         join(OUT, 'pair.html'));
await copyIfExists(join(SRC, 'popup', 'popup.html'), join(OUT, 'popup', 'popup.html'));
await copyIfExists(join(SRC, 'icons'),             join(OUT, 'icons'));

// Sanity: list what we have.
if (await exists(OUT)) {
  const entries = await readdir(OUT, { withFileTypes: true });
  console.log(`[copy-static] build/ contains: ${entries.map(e => e.name).join(', ')}`);
}
