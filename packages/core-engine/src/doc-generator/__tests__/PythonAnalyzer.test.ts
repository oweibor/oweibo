import path from 'node:path';
import fs from 'node:fs';
import { PythonAnalyzer } from '../analysis/analyzers/PythonAnalyzer.js';
import { describeILanguageAnalyzerContract } from '@oweibo/core-contracts/testing';

const FIXTURES = path.join(__dirname, 'fixtures');
const PY_SIMPLE = path.join(FIXTURES, 'py-simple');
const MODELS_PY = path.join(PY_SIMPLE, 'models.py');
const ROUTES_PY = path.join(PY_SIMPLE, 'routes.py');

const analyzer = new PythonAnalyzer();

afterAll(() => { analyzer.shutdown(); });

// ── Contract suite ────────────────────────────────────────────────────────────

describeILanguageAnalyzerContract(analyzer, {
  filePath: MODELS_PY,
  content:  fs.readFileSync(MODELS_PY, 'utf-8'),
  language: 'python',
});

// ── Regex fallback (no Python subprocess) ────────────────────────────────────

describe('PythonAnalyzer — regex fallback', () => {
  const SIMPLE_CONTENT = `
def greet(name):
    """Return a greeting."""
    return f"Hello, {name}"

class Greeter:
    def greet(self, name):
        return greet(name)

import os
from pathlib import Path
`.trim();

  it('extracts top-level def via regex', async () => {
    // Pass content directly to analyzeFile — the file doesn't need to exist on disk
    // because PythonAnalyzer falls back to regex when Python isn't available
    const tmpPath = path.join(PY_SIMPLE, '__fallback_test__.py');
    fs.writeFileSync(tmpPath, SIMPLE_CONTENT, 'utf-8');
    try {
      const analysis = await analyzer.analyzeFile(tmpPath, SIMPLE_CONTENT);
      const names = analysis.exports.map((s) => s.name);
      expect(names).toContain('greet');
      expect(names).toContain('Greeter');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it('extracts imports via regex fallback path', async () => {
    const tmpPath = path.join(PY_SIMPLE, '__fallback_import_test__.py');
    fs.writeFileSync(tmpPath, SIMPLE_CONTENT, 'utf-8');
    try {
      const analysis = await analyzer.analyzeFile(tmpPath, SIMPLE_CONTENT);
      const sources = analysis.imports.map((i) => i.source);
      expect(sources).toContain('os');
      expect(sources).toContain('pathlib');
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});

// ── Unit tests (subprocess + fixture files) ───────────────────────────────────

describe('PythonAnalyzer — analyzeFile (models.py)', () => {
  it('returns language python', async () => {
    const content = fs.readFileSync(MODELS_PY, 'utf-8');
    const analysis = await analyzer.analyzeFile(MODELS_PY, content);
    expect(analysis.language).toBe('python');
  });

  it('extracts Order and OrderItem classes', async () => {
    const content = fs.readFileSync(MODELS_PY, 'utf-8');
    const analysis = await analyzer.analyzeFile(MODELS_PY, content);
    const names = analysis.exports.map((s) => s.name);
    expect(names).toContain('Order');
    expect(names).toContain('OrderItem');
  });

  it('Order class has kind=class', async () => {
    const content = fs.readFileSync(MODELS_PY, 'utf-8');
    const analysis = await analyzer.analyzeFile(MODELS_PY, content);
    const order = analysis.exports.find((s) => s.name === 'Order');
    expect(order?.kind).toBe('class');
  });

  it('extracts cancel method or top-level functions', async () => {
    const content = fs.readFileSync(MODELS_PY, 'utf-8');
    const analysis = await analyzer.analyzeFile(MODELS_PY, content);
    // Either AST (finds cancel as function) or regex (finds Order class + top-level defs)
    expect(analysis.exports.length).toBeGreaterThan(0);
  });
});

describe('PythonAnalyzer — analyzeDirectory', () => {
  it('returns one FileAnalysis per .py file', async () => {
    const files = [MODELS_PY, ROUTES_PY];
    const results = await analyzer.analyzeDirectory(PY_SIMPLE, files);
    expect(results).toHaveLength(2);
  });

  it('returns empty array for empty input', async () => {
    const results = await analyzer.analyzeDirectory(PY_SIMPLE, []);
    expect(results).toHaveLength(0);
  });

  it('all results have language python', async () => {
    const files = [MODELS_PY, ROUTES_PY];
    const results = await analyzer.analyzeDirectory(PY_SIMPLE, files);
    results.forEach((r) => expect(r.language).toBe('python'));
  });

  it('lineCount reflects actual file content', async () => {
    const files = [MODELS_PY];
    const results = await analyzer.analyzeDirectory(PY_SIMPLE, files);
    const actual = fs.readFileSync(MODELS_PY, 'utf-8').split('\n').length;
    expect(results[0]!.lineCount).toBe(actual);
  });
});

describe('PythonAnalyzer — extractCallGraph', () => {
  it('returns an array (may be empty)', async () => {
    const files = await analyzer.analyzeDirectory(PY_SIMPLE, [MODELS_PY, ROUTES_PY]);
    const edges = await analyzer.extractCallGraph(files);
    expect(Array.isArray(edges)).toBe(true);
  });
});

describe('PythonAnalyzer — AbortSignal', () => {
  it('throws on already-aborted signal in analyzeDirectory', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      analyzer.analyzeDirectory(PY_SIMPLE, [MODELS_PY], ctrl.signal),
    ).rejects.toThrow();
  });
});

describe('PythonAnalyzer — empty/binary content', () => {
  it('handles empty string without throwing', async () => {
    const tmpPath = path.join(PY_SIMPLE, '__empty_test__.py');
    fs.writeFileSync(tmpPath, '', 'utf-8');
    try {
      await expect(analyzer.analyzeFile(tmpPath, '')).resolves.toBeDefined();
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
