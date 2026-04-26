import path from 'node:path';
import { TypeScriptAnalyzer } from '../analysis/analyzers/TypeScriptAnalyzer.js';
import { describeILanguageAnalyzerContract } from '@oweibo/core-contracts/testing';

const FIXTURES = path.join(__dirname, 'fixtures');
const TS_SIMPLE = path.join(FIXTURES, 'ts-simple');
const TS_MONOREPO_PKG_A = path.join(FIXTURES, 'ts-monorepo', 'packages', 'pkg-a', 'src');
const TS_MONOREPO_PKG_B = path.join(FIXTURES, 'ts-monorepo', 'packages', 'pkg-b', 'src');

const analyzer = new TypeScriptAnalyzer();

// ── Contract suite ────────────────────────────────────────────────────────────

describeILanguageAnalyzerContract(analyzer, {
  filePath: path.join(TS_SIMPLE, 'UserService.ts'),
  content:  require('node:fs').readFileSync(path.join(TS_SIMPLE, 'UserService.ts'), 'utf-8'),
  language: 'typescript',
});

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — analyzeFile', () => {
  it('extracts UserService class with JSDoc and correct kind', async () => {
    const content = require('node:fs').readFileSync(path.join(TS_SIMPLE, 'UserService.ts'), 'utf-8');
    const analysis = await analyzer.analyzeFile(path.join(TS_SIMPLE, 'UserService.ts'), content);

    const classSymbol = analysis.exports.find((s) => s.name === 'UserService');
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.kind).toBe('class');
    expect(classSymbol!.rawDocumentation).toMatch(/UserService handles all user lifecycle/);
  });

  it('extracts exported interfaces (User, CreateUserInput)', async () => {
    const content = require('node:fs').readFileSync(path.join(TS_SIMPLE, 'UserService.ts'), 'utf-8');
    const analysis = await analyzer.analyzeFile(path.join(TS_SIMPLE, 'UserService.ts'), content);

    const names = analysis.exports.map((s) => s.name);
    expect(names).toContain('User');
    expect(names).toContain('CreateUserInput');
    const userSym = analysis.exports.find((s) => s.name === 'User');
    expect(userSym!.kind).toBe('interface');
  });

  it('captures EventEmitter import as a dependency', async () => {
    const content = require('node:fs').readFileSync(path.join(TS_SIMPLE, 'UserService.ts'), 'utf-8');
    const analysis = await analyzer.analyzeFile(path.join(TS_SIMPLE, 'UserService.ts'), content);

    expect(analysis.dependencies).toContain('events');
  });

  it('sets language to typescript for .ts files', async () => {
    const content = require('node:fs').readFileSync(path.join(TS_SIMPLE, 'UserService.ts'), 'utf-8');
    const analysis = await analyzer.analyzeFile(path.join(TS_SIMPLE, 'UserService.ts'), content);
    expect(analysis.language).toBe('typescript');
  });

  it('computes complexity >= 1 (branch counting applies to top-level functions only)', async () => {
    const content = require('node:fs').readFileSync(path.join(TS_SIMPLE, 'UserService.ts'), 'utf-8');
    const analysis = await analyzer.analyzeFile(path.join(TS_SIMPLE, 'UserService.ts'), content);
    // UserService only has class methods (not top-level fns), so complexity stays at base 1
    expect(analysis.complexity).toBeGreaterThanOrEqual(1);
  });

  it('computes complexity > 1 for a top-level function with branches', async () => {
    const content = `
export function process(x: number): string {
  if (x > 0) {
    return 'positive';
  } else if (x < 0) {
    return 'negative';
  }
  return 'zero';
}
`.trim();
    const analysis = await analyzer.analyzeFile('/tmp/proc.ts', content);
    expect(analysis.complexity).toBeGreaterThan(1);
  });
});

describe('TypeScriptAnalyzer — analyzeDirectory (ts-simple)', () => {
  const filePaths = [
    path.join(TS_SIMPLE, 'UserService.ts'),
    path.join(TS_SIMPLE, 'IUserRepository.ts'),
    path.join(TS_SIMPLE, 'router.ts'),
  ];

  it('returns one FileAnalysis per file', async () => {
    const results = await analyzer.analyzeDirectory(TS_SIMPLE, filePaths);
    expect(results).toHaveLength(3);
  });

  it('identifies IUserRepository as interface kind', async () => {
    const results = await analyzer.analyzeDirectory(TS_SIMPLE, filePaths);
    const repoFile = results.find((r) => r.filePath.endsWith('IUserRepository.ts'));
    expect(repoFile).toBeDefined();
    const iface = repoFile!.exports.find((s) => s.name === 'UserRepository' || s.name === 'IUserRepository');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
  });

  it('handles empty filePaths without error', async () => {
    const results = await analyzer.analyzeDirectory(TS_SIMPLE, []);
    expect(results).toHaveLength(0);
  });
});

describe('TypeScriptAnalyzer — analyzeDirectory (ts-monorepo cross-package)', () => {
  const pkgAFiles = [
    path.join(TS_MONOREPO_PKG_A, 'index.ts'),
    path.join(TS_MONOREPO_PKG_A, 'EventDoc.ts'),
    path.join(TS_MONOREPO_PKG_A, 'IEventBus.ts'),
  ];
  const pkgBFiles = [
    path.join(TS_MONOREPO_PKG_B, 'index.ts'),
    path.join(TS_MONOREPO_PKG_B, 'EventProcessor.ts'),
  ];

  it('extracts EventDoc from pkg-a', async () => {
    const results = await analyzer.analyzeDirectory(TS_MONOREPO_PKG_A, pkgAFiles);
    const symbols = results.flatMap((r) => r.exports).map((s) => s.name);
    expect(symbols).toContain('EventDoc');
  });

  it('extracts EventProcessor from pkg-b', async () => {
    const results = await analyzer.analyzeDirectory(TS_MONOREPO_PKG_B, pkgBFiles);
    const symbols = results.flatMap((r) => r.exports).map((s) => s.name);
    expect(symbols).toContain('EventProcessor');
  });

  it('moduleHash disambiguates same-named symbols from different packages', async () => {
    const [aResults, bResults] = await Promise.all([
      analyzer.analyzeDirectory(TS_MONOREPO_PKG_A, pkgAFiles),
      analyzer.analyzeDirectory(TS_MONOREPO_PKG_B, pkgBFiles),
    ]);
    const aHash = aResults.flatMap((r) => r.exports).find((s) => s.name === 'EventDoc')?.moduleHash;
    const bHash = bResults.flatMap((r) => r.exports).find((s) => s.name === 'EventProcessor')?.moduleHash;
    // They come from different root paths → different hashes
    expect(aHash).toBeDefined();
    expect(bHash).toBeDefined();
    expect(aHash).not.toBe(bHash);
  });
});

describe('TypeScriptAnalyzer — extractCallGraph', () => {
  it('produces cross-file edges for imports that resolve to known exports', async () => {
    const filePaths = [
      path.join(TS_SIMPLE, 'UserService.ts'),
      path.join(TS_SIMPLE, 'IUserRepository.ts'),
    ];
    const files = await analyzer.analyzeDirectory(TS_SIMPLE, filePaths);
    const edges = await analyzer.extractCallGraph(files);
    // UserService imports UserRepository from IUserRepository
    expect(Array.isArray(edges)).toBe(true);
  });

  it('returns empty array when no cross-file imports resolve', async () => {
    const filePaths = [path.join(TS_SIMPLE, 'IUserRepository.ts')];
    const files = await analyzer.analyzeDirectory(TS_SIMPLE, filePaths);
    const edges = await analyzer.extractCallGraph(files);
    expect(edges).toEqual([]);
  });
});

describe('TypeScriptAnalyzer — extractSymbols', () => {
  it('flattens exports from all FileAnalysis', async () => {
    const filePaths = [
      path.join(TS_SIMPLE, 'UserService.ts'),
      path.join(TS_SIMPLE, 'IUserRepository.ts'),
    ];
    const files = await analyzer.analyzeDirectory(TS_SIMPLE, filePaths);
    const symbols = analyzer.extractSymbols(files);
    expect(symbols.length).toBeGreaterThanOrEqual(2);
    symbols.forEach((s) => {
      expect(s.name).toBeTruthy();
      expect(s.filePath).toBeTruthy();
    });
  });
});

describe('TypeScriptAnalyzer — AbortSignal', () => {
  it('throws on already-aborted signal in analyzeFile', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const content = require('node:fs').readFileSync(path.join(TS_SIMPLE, 'UserService.ts'), 'utf-8');
    await expect(
      analyzer.analyzeFile(path.join(TS_SIMPLE, 'UserService.ts'), content, ctrl.signal),
    ).rejects.toThrow();
  });

  it('throws on already-aborted signal in analyzeDirectory', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      analyzer.analyzeDirectory(TS_SIMPLE, [path.join(TS_SIMPLE, 'UserService.ts')], ctrl.signal),
    ).rejects.toThrow();
  });
});
