/**
 * Sign all frame templates in packages/prompt-registry/templates/.
 * Run after authoring or editing any .tpl file:
 *   FRAME_SIGNING_KEY=<key> tsx scripts/sign-frame-templates.ts
 */
import { createHmac } from 'crypto';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const key = process.env['FRAME_SIGNING_KEY'];
if (!key) { console.error('FRAME_SIGNING_KEY is required'); process.exit(1); }

const templatesDir = join(import.meta.dirname ?? __dirname, '..', 'packages', 'prompt-registry', 'templates');
const sigsDir      = join(templatesDir, 'sigs');

const files = readdirSync(templatesDir).filter(f => f.endsWith('.tpl'));
if (files.length === 0) { console.log('No .tpl files found — nothing to sign.'); process.exit(0); }

for (const file of files) {
  const text = readFileSync(join(templatesDir, file), 'utf-8');
  const sig  = createHmac('sha256', key).update(text).digest('hex');
  writeFileSync(join(sigsDir, `${file}.sig`), sig + '\n', 'utf-8');
  console.log(`Signed ${file} → sigs/${file}.sig`);
}
console.log(`Done — signed ${files.length} template(s).`);
