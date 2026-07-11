/**
 * T.2.c — smoke test for the shipped SKILL.md seed bundle. Verifies that
 * every skill directory contains a SKILL.md with valid frontmatter and a
 * non-empty body, plus the .skill-source.json sidecar that records the
 * platform-seed provenance.
 *
 * This is intentionally a structural test, not a SkillRegistry integration
 * test — the latter would need ModelRouter, Qdrant, Redis, and Vault. We
 * just confirm the on-disk layout matches what SkillRegistry.discover()
 * will be looking for.
 */
import * as fs from 'fs';
import * as path from 'path';

const BUNDLE_DIR = path.join(__dirname, '..', 'skills');

interface Frontmatter {
  name?: string;
  description?: string;
  tags?: unknown;
  applies_to?: unknown;
}

function parseFrontmatter(rawInput: string): { fm: Frontmatter; body: string } {
  // Normalize CRLF: on Windows checkouts (core.autocrlf) every line carries a
  // trailing \r, which the (.*)$ key regex below cannot anchor past — every
  // frontmatter key silently parsed as missing (found 2026-07-10). The real
  // SkillRegistry parser uses a YAML library and is not affected; this
  // structural mirror must be equally line-ending-agnostic.
  const raw = rawInput.replace(/\r\n/g, '\n');
  if (!raw.startsWith('---\n')) {
    throw new Error('missing leading --- delimiter');
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) throw new Error('missing trailing --- delimiter');
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\s+/, '');
  const fm: Frontmatter = {};
  for (const line of yaml.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as keyof Frontmatter;
    const val = m[2]?.trim() ?? '';
    if (key === 'tags' || key === 'applies_to') {
      // Minimal array parser: [a, b, c]
      const arr = /^\[(.+)\]$/.exec(val);
      (fm as Record<string, unknown>)[key] = arr
        ? arr[1]!.split(',').map((s) => s.trim())
        : [];
    } else {
      (fm as Record<string, unknown>)[key] = val;
    }
  }
  return { fm, body };
}

describe('seed/skills bundle', () => {
  let skillDirs: string[] = [];

  beforeAll(() => {
    skillDirs = fs.readdirSync(BUNDLE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  });

  it('ships at least 5 skill directories', () => {
    expect(skillDirs.length).toBeGreaterThanOrEqual(5);
  });

  it('every skill dir contains SKILL.md and .skill-source.json', () => {
    for (const dir of skillDirs) {
      const skillPath = path.join(BUNDLE_DIR, dir, 'SKILL.md');
      const sidePath  = path.join(BUNDLE_DIR, dir, '.skill-source.json');
      expect(fs.existsSync(skillPath)).toBe(true);
      expect(fs.existsSync(sidePath)).toBe(true);
    }
  });

  it('every SKILL.md has well-formed frontmatter with name + description', () => {
    for (const dir of skillDirs) {
      const raw = fs.readFileSync(path.join(BUNDLE_DIR, dir, 'SKILL.md'), 'utf-8');
      const { fm, body } = parseFrontmatter(raw);
      expect(fm.name).toBeTruthy();
      expect(fm.description).toBeTruthy();
      expect(body.length).toBeGreaterThan(50);
    }
  });

  it('every .skill-source.json declares the platform:seed-bundle remote', () => {
    for (const dir of skillDirs) {
      const sidecar = JSON.parse(
        fs.readFileSync(path.join(BUNDLE_DIR, dir, '.skill-source.json'), 'utf-8'),
      ) as { remote?: string; integrity?: string };
      expect(sidecar.remote).toBe('platform:seed-bundle');
      expect(sidecar.integrity).toBeTruthy();
    }
  });

  it('every SKILL.md is under SkillRegistry.MAX_FILE_SIZE_BYTES (100 KB)', () => {
    const LIMIT = 100 * 1024;
    for (const dir of skillDirs) {
      const stat = fs.statSync(path.join(BUNDLE_DIR, dir, 'SKILL.md'));
      expect(stat.size).toBeLessThanOrEqual(LIMIT);
    }
  });
});
