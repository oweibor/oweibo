import path from 'node:path';
import fs from 'node:fs';
import { GenericAnalyzer } from '../analysis/analyzers/GenericAnalyzer.js';
import { describeILanguageAnalyzerContract } from '@oweibo/core-contracts/testing';

const FIXTURES = path.join(__dirname, 'fixtures');
const MIXED = path.join(FIXTURES, 'mixed-lang');
const HANDLER_GO = path.join(MIXED, 'handler.go');

const analyzer = new GenericAnalyzer();

// ── Contract suite ────────────────────────────────────────────────────────────

describeILanguageAnalyzerContract(analyzer, {
  filePath: HANDLER_GO,
  content:  fs.readFileSync(HANDLER_GO, 'utf-8'),
  language: 'go',
});

// ── Go handler.go ─────────────────────────────────────────────────────────────

describe('GenericAnalyzer — Go (handler.go)', () => {
  const content = fs.readFileSync(HANDLER_GO, 'utf-8');

  it('sets language to go', async () => {
    const analysis = await analyzer.analyzeFile(HANDLER_GO, content);
    expect(analysis.language).toBe('go');
  });

  it('extracts IngestHandler as a function symbol', async () => {
    const analysis = await analyzer.analyzeFile(HANDLER_GO, content);
    const sym = analysis.exports.find((s) => s.name === 'IngestHandler');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts Event as a struct/class symbol', async () => {
    const analysis = await analyzer.analyzeFile(HANDLER_GO, content);
    const sym = analysis.exports.find((s) => s.name === 'Event');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  it('returns imports array (Go block imports are not matched by line-based regex)', async () => {
    const analysis = await analyzer.analyzeFile(HANDLER_GO, content);
    // GenericAnalyzer matches `import "pkg"` single-line form only; block form yields []
    expect(Array.isArray(analysis.imports)).toBe(true);
  });

  it('complexity increases with if/for/switch branches', async () => {
    const analysis = await analyzer.analyzeFile(HANDLER_GO, content);
    // handler.go has an `if err := ...; err != nil` branch → complexity > 1
    expect(analysis.complexity).toBeGreaterThan(1);
  });
});

// ── Rust ──────────────────────────────────────────────────────────────────────

describe('GenericAnalyzer — Rust inline content', () => {
  const RS_CONTENT = `
pub fn compute(x: i32) -> i32 {
    if x > 0 { x * 2 } else { 0 }
}

pub struct Config {
    pub timeout: u64,
}

pub trait Processor {
    fn process(&self) -> bool;
}
`.trim();

  const fakeRsPath = '/tmp/fixture.rs';

  it('detects language rust', async () => {
    const analysis = await analyzer.analyzeFile(fakeRsPath, RS_CONTENT);
    expect(analysis.language).toBe('rust');
  });

  it('extracts pub fn as function', async () => {
    const analysis = await analyzer.analyzeFile(fakeRsPath, RS_CONTENT);
    const sym = analysis.exports.find((s) => s.name === 'compute');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts pub struct as class', async () => {
    const analysis = await analyzer.analyzeFile(fakeRsPath, RS_CONTENT);
    const sym = analysis.exports.find((s) => s.name === 'Config');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  it('extracts pub trait as interface', async () => {
    const analysis = await analyzer.analyzeFile(fakeRsPath, RS_CONTENT);
    const sym = analysis.exports.find((s) => s.name === 'Processor');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('interface');
  });
});

// ── Java ──────────────────────────────────────────────────────────────────────

describe('GenericAnalyzer — Java inline content', () => {
  const JAVA_CONTENT = `
import com.example.Service;

public class UserController {
    public UserResponse getUser(String id) {
        return null;
    }
}

public interface UserRepository {
    UserEntity findById(String id);
}
`.trim();

  const fakeJavaPath = '/tmp/UserController.java';

  it('detects language java', async () => {
    const analysis = await analyzer.analyzeFile(fakeJavaPath, JAVA_CONTENT);
    expect(analysis.language).toBe('java');
  });

  it('extracts UserController as class', async () => {
    const analysis = await analyzer.analyzeFile(fakeJavaPath, JAVA_CONTENT);
    const sym = analysis.exports.find((s) => s.name === 'UserController');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  it('extracts UserRepository as interface', async () => {
    const analysis = await analyzer.analyzeFile(fakeJavaPath, JAVA_CONTENT);
    const sym = analysis.exports.find((s) => s.name === 'UserRepository');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('interface');
  });

  it('captures import com.example.Service', async () => {
    const analysis = await analyzer.analyzeFile(fakeJavaPath, JAVA_CONTENT);
    const sources = analysis.imports.map((i) => i.source);
    expect(sources).toContain('com.example.Service');
  });
});

// ── Unknown extension ──────────────────────────────────────────────────────────

describe('GenericAnalyzer — unknown extension', () => {
  it('returns language unknown for .xyz files', async () => {
    const analysis = await analyzer.analyzeFile('/tmp/file.xyz', 'some content');
    expect(analysis.language).toBe('unknown');
  });

  it('returns empty exports for unrecognised extension', async () => {
    const analysis = await analyzer.analyzeFile('/tmp/file.xyz', 'some content');
    expect(analysis.exports).toEqual([]);
  });
});

// ── analyzeDirectory ──────────────────────────────────────────────────────────

describe('GenericAnalyzer — analyzeDirectory', () => {
  it('returns one result per file in mixed-lang directory', async () => {
    const results = await analyzer.analyzeDirectory(MIXED, [HANDLER_GO]);
    expect(results).toHaveLength(1);
  });

  it('skips unreadable file paths and still returns results for readable ones', async () => {
    const results = await analyzer.analyzeDirectory(MIXED, [
      HANDLER_GO,
      path.join(MIXED, 'nonexistent.go'),
    ]);
    // Should get 2 results: one real, one emptyAnalysis
    expect(results).toHaveLength(2);
  });

  it('returns empty array for empty input', async () => {
    const results = await analyzer.analyzeDirectory(MIXED, []);
    expect(results).toHaveLength(0);
  });
});

// ── extractCallGraph always returns [] ────────────────────────────────────────

describe('GenericAnalyzer — extractCallGraph', () => {
  it('returns empty array (no call graph for generic files)', async () => {
    const files = await analyzer.analyzeDirectory(MIXED, [HANDLER_GO]);
    const edges = await analyzer.extractCallGraph(files);
    expect(edges).toEqual([]);
  });
});

// ── AbortSignal ───────────────────────────────────────────────────────────────

describe('GenericAnalyzer — AbortSignal', () => {
  it('throws on already-aborted signal in analyzeFile', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      analyzer.analyzeFile(HANDLER_GO, 'content', ctrl.signal),
    ).rejects.toThrow();
  });

  it('throws on already-aborted signal in extractCallGraph', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      analyzer.extractCallGraph([], ctrl.signal),
    ).rejects.toThrow();
  });
});
