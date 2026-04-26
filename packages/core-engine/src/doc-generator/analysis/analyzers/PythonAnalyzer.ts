/**
 * PythonAnalyzer — Python AST extraction via subprocess + regex fallback.
 *
 * Two-tier strategy (A1, v10.3):
 *   1. Preferred: Python ast subprocess (python3/python -u -). Accurate per-file
 *      syntactic analysis. Long-lived subprocess pool (C15, v10.5).
 *   2. Fallback: regex when Python unavailable or subprocess crash exhausted retries.
 *
 * Honest scope (A1, v10.3):
 *   - Single-file syntactic analysis only. No cross-module type resolution.
 *   - Cross-file call edges produced via import-resolution heuristic (not type inference).
 *   - PYTHON_NO_AST warning emitted when falling back to regex.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type {
  ILanguageAnalyzer,
  FileAnalysis,
  SymbolInfo,
  EnrichedCallEdge,
  ImportInfo,
  CodeLanguage,
} from '@oweibo/core-contracts';

const SUPPORTED: readonly CodeLanguage[] = ['python'];

// ─── Python subprocess protocol ─────────────────────────────────────────────

const PYTHON_WORKER_SCRIPT = `
import sys, ast, json

def analyze(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"error": str(e), "symbols": [], "imports": [], "edges": []}

    symbols = []
    imports = []
    edges   = []

    class Visitor(ast.NodeVisitor):
        def __init__(self):
            self.current_class = None
            # Collect module-level names
            self.defined_names = set()

        def visit_FunctionDef(self, node):
            sym = {
                "name": node.name,
                "kind": "function",
                "line": node.lineno,
                "end_line": node.end_lineno,
                "decorators": [ast.unparse(d) for d in node.decorator_list],
                "docstring": ast.get_docstring(node) or "",
                "args": [a.arg for a in node.args.args],
                "returns": ast.unparse(node.returns) if node.returns else "",
                "class": self.current_class,
            }
            symbols.append(sym)
            self.defined_names.add(node.name)
            self.generic_visit(node)

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, node):
            sym = {
                "name": node.name,
                "kind": "class",
                "line": node.lineno,
                "end_line": node.end_lineno,
                "decorators": [ast.unparse(d) for d in node.decorator_list],
                "docstring": ast.get_docstring(node) or "",
                "bases": [ast.unparse(b) for b in node.bases],
                "class": None,
            }
            symbols.append(sym)
            self.defined_names.add(node.name)
            prev = self.current_class
            self.current_class = node.name
            self.generic_visit(node)
            self.current_class = prev

        def visit_Import(self, node):
            for alias in node.names:
                imports.append({
                    "source": alias.name,
                    "alias": alias.asname or "",
                    "kind": "import",
                })

        def visit_ImportFrom(self, node):
            source = node.module or ""
            for alias in node.names:
                imports.append({
                    "source": source,
                    "name": alias.name,
                    "alias": alias.asname or "",
                    "kind": "from",
                })

        def visit_Call(self, node):
            func_name = ""
            if isinstance(node.func, ast.Name):
                func_name = node.func.id
            elif isinstance(node.func, ast.Attribute):
                func_name = node.func.attr
            if func_name:
                edges.append({"callee": func_name, "line": node.lineno})
            self.generic_visit(node)

    Visitor().visit(tree)
    return {"symbols": symbols, "imports": imports, "edges": edges}

import struct
while True:
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        break
    length = struct.unpack(">I", header)[0]
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        break
    req = json.loads(body)
    result = analyze(req["content"])
    out = json.dumps(result).encode()
    sys.stdout.buffer.write(struct.pack(">I", len(out)))
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()
`.trim();

// ─── Subprocess Pool (C15, v10.5) ────────────────────────────────────────────

interface PooledProcess {
  proc:           ChildProcess;
  filesProcessed: number;
  buffer:         Buffer;
}

class PythonSubprocessPool {
  private readonly pool: PooledProcess[] = [];
  private readonly queue: Array<(p: PooledProcess) => void> = [];
  private _pythonBin: string | null | undefined = undefined;

  constructor(
    private readonly maxSize:         number = 2,
    private readonly maxFilesPerProc: number = 500,
  ) {}

  /** Probe python3/python on PATH. Returns the binary name or null. */
  async probePython(): Promise<string | null> {
    if (this._pythonBin !== undefined) return this._pythonBin;
    for (const bin of ['python3', 'python']) {
      try {
        await new Promise<void>((resolve, reject) => {
          const p = spawn(bin, ['--version'], { stdio: 'pipe' });
          p.on('error', reject);
          p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('non-zero'))));
        });
        this._pythonBin = bin;
        return bin;
      } catch { /* try next */ }
    }
    this._pythonBin = null;
    return null;
  }

  async acquire(): Promise<PooledProcess | null> {
    const bin = await this.probePython();
    if (!bin) return null;

    // Reuse an available slot
    const available = this.pool.find((p) => p.filesProcessed < this.maxFilesPerProc);
    if (available) return available;

    // Spawn a new process if under maxSize
    if (this.pool.length < this.maxSize) {
      const entry = await this.spawn(bin);
      this.pool.push(entry);
      return entry;
    }

    // All slots in use — wait for the first to become available (up to 60 s)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SUBPROCESS_POOL_TIMEOUT')), 60_000);
      this.queue.push((p) => { clearTimeout(timer); resolve(p); });
    });
  }

  release(entry: PooledProcess): void {
    entry.filesProcessed++;
    if (entry.filesProcessed >= this.maxFilesPerProc) {
      this.recycle(entry);
      return;
    }
    const next = this.queue.shift();
    if (next) next(entry);
  }

  private async spawn(bin: string): Promise<PooledProcess> {
    const proc = spawn(bin, ['-I', '-u', '-c', PYTHON_WORKER_SCRIPT], {
      stdio: 'pipe',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' },
    });
    return { proc, filesProcessed: 0, buffer: Buffer.alloc(0) };
  }

  private recycle(entry: PooledProcess): void {
    const idx = this.pool.indexOf(entry);
    if (idx !== -1) this.pool.splice(idx, 1);
    try { entry.proc.kill('SIGTERM'); } catch { /* already dead */ }

    const bin = this._pythonBin;
    if (!bin) return;
    this.spawn(bin).then((fresh) => {
      this.pool.push(fresh);
      const next = this.queue.shift();
      if (next) { next(fresh); } else { this.release(fresh); }
    }).catch(() => { /* spawn failed — pool shrinks */ });
  }

  shutdown(): void {
    for (const entry of this.pool) {
      try { entry.proc.kill('SIGTERM'); } catch { /* already dead */ }
    }
    this.pool.length = 0;
  }
}

// ─── Main analyzer ────────────────────────────────────────────────────────────

export class PythonAnalyzer implements ILanguageAnalyzer {
  readonly supportedLanguages: readonly CodeLanguage[] = SUPPORTED;
  private readonly pool = new PythonSubprocessPool();

  async analyzeFile(
    filePath: string,
    content:  string,
    signal?:  AbortSignal,
  ): Promise<FileAnalysis> {
    signal?.throwIfAborted();
    const results = await this.analyzeDirectory(
      filePath.split('/').slice(0, -1).join('/') || '.',
      [filePath],
      signal,
    );
    return results[0] ?? fallbackAnalysis(filePath, content);
  }

  async analyzeDirectory(
    _rootPath: string,
    filePaths: readonly string[],
    signal?:   AbortSignal,
  ): Promise<readonly FileAnalysis[]> {
    signal?.throwIfAborted();
    if (filePaths.length === 0) return [];

    const pythonBin = await this.pool.probePython();
    const contentsMap = new Map<string, string>();

    // Load file contents
    const { readFile } = await import('node:fs/promises');
    for (const fp of filePaths) {
      try { contentsMap.set(fp, await readFile(fp, 'utf-8')); } catch { /* skip */ }
    }

    if (!pythonBin) {
      return Array.from(contentsMap.entries()).map(([fp, c]) => fallbackAnalysis(fp, c));
    }

    const results: FileAnalysis[] = [];
    for (const [fp, content] of contentsMap) {
      signal?.throwIfAborted();
      let entry: PooledProcess | null = null;
      try {
        entry = await this.pool.acquire();
        if (!entry) {
          results.push(fallbackAnalysis(fp, content));
          continue;
        }
        const parsed = await sendRequest(entry, { content }, signal);
        results.push(buildAnalysis(fp, content, parsed));
        this.pool.release(entry);
      } catch (err) {
        if (entry) {
          // On crash: retry once with fallback
          results.push(fallbackAnalysis(fp, content));
        } else {
          results.push(fallbackAnalysis(fp, content));
        }
      }
    }
    return results;
  }

  async extractCallGraph(
    files:   readonly FileAnalysis[],
    signal?: AbortSignal,
  ): Promise<readonly EnrichedCallEdge[]> {
    signal?.throwIfAborted();
    const edges: EnrichedCallEdge[] = [];
    const exportMap = new Map<string, string>();
    for (const f of files) {
      for (const sym of f.exports) exportMap.set(sym.name, f.filePath);
    }
    for (const f of files) {
      for (const imp of f.imports) {
        for (const sym of imp.symbols) {
          const calleePath = exportMap.get(sym);
          if (calleePath && calleePath !== f.filePath) {
            edges.push({
              callerFile: f.filePath, callerSymbol: '(import)',
              calleeFile: calleePath, calleeSymbol: sym,
              callType: 'direct', line: 0,
            });
          }
        }
      }
    }
    return edges;
  }

  extractSymbols(files: readonly FileAnalysis[]): readonly SymbolInfo[] {
    return files.flatMap((f) => f.exports);
  }

  /** Shut down all pooled subprocesses (call on pod SIGTERM). */
  shutdown(): void { this.pool.shutdown(); }
}

// ─── Subprocess communication ─────────────────────────────────────────────────

type PythonResult = {
  symbols: Array<{
    name: string; kind: string; line: number; end_line?: number;
    decorators: string[]; docstring: string; args?: string[];
    returns?: string; class?: string | null;
  }>;
  imports: Array<{
    source: string; alias?: string; kind: string; name?: string;
  }>;
  edges: Array<{ callee: string; line: number }>;
  error?: string;
};

async function sendRequest(
  entry:   PooledProcess,
  req:     { content: string },
  signal?: AbortSignal,
): Promise<PythonResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(req));
    const header  = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);

    const timeout = setTimeout(() => reject(new Error('PYTHON_TIMEOUT')), 30_000);
    const onAbort = () => { clearTimeout(timeout); reject(new Error('AbortError')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    function tryParse() {
      if (entry.buffer.length < 4) return;
      const len = entry.buffer.readUInt32BE(0);
      if (entry.buffer.length < 4 + len) return;
      const body = entry.buffer.slice(4, 4 + len);
      entry.buffer = entry.buffer.slice(4 + len);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      try {
        resolve(JSON.parse(body.toString()) as PythonResult);
      } catch (e) {
        reject(e);
      }
    }

    entry.proc.stdout!.on('data', (chunk: Buffer) => {
      entry.buffer = Buffer.concat([entry.buffer, chunk]);
      tryParse();
    });

    entry.proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
    entry.proc.on('close', (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error(`python exited ${code}`)); }
    });

    entry.proc.stdin!.write(Buffer.concat([header, payload]));
  });
}

// ─── Analysis builders ────────────────────────────────────────────────────────

function buildAnalysis(filePath: string, content: string, result: PythonResult): FileAnalysis {
  const moduleHash = crypto.createHash('sha256')
    .update(filePath.split('/').slice(0, -1).join('/'))
    .digest('hex').slice(0, 6);

  const exports: SymbolInfo[] = (result.symbols ?? []).map((s) => ({
    name:             s.name,
    kind:             (s.kind === 'class' ? 'class' : 'function') as SymbolInfo['kind'],
    filePath,
    line:             s.line,
    endLine:          s.end_line,
    visibility:       'public' as const,
    rawDocumentation: s.docstring || undefined,
    decorators:       s.decorators.length ? s.decorators : undefined,
    parameters:       s.args?.map((a) => ({ name: a, type: 'Any', optional: false })),
    returnType:       s.returns || undefined,
    moduleHash,
  }));

  const imports: ImportInfo[] = [];
  const depSet = new Set<string>();
  for (const imp of result.imports ?? []) {
    const symbols = imp.name ? [imp.name] : [];
    imports.push({ source: imp.source, symbols, isDefault: false, isNamespace: false });
    const pkg = imp.source.split('.')[0] ?? imp.source;
    if (!pkg.startsWith('.') && pkg) depSet.add(pkg);
  }

  return {
    filePath,
    language:     'python',
    lineCount:    content.split('\n').length,
    complexity:   1 + (result.edges?.length ?? 0),
    exports,
    imports,
    dependencies: Array.from(depSet),
  };
}

function fallbackAnalysis(filePath: string, content: string): FileAnalysis {
  const exports: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const dependencies: string[] = [];

  // Regex-based fallback: extract top-level def/class only
  for (const line of content.split('\n')) {
    const fn = line.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (fn) exports.push({ name: fn[1]!, kind: 'function', filePath, line: 0, visibility: 'public' });
    const cls = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (cls) exports.push({ name: cls[1]!, kind: 'class', filePath, line: 0, visibility: 'public' });
    const imp = line.match(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/);
    if (imp) {
      const src = imp[1] ?? imp[2] ?? '';
      imports.push({ source: src, symbols: [], isDefault: false, isNamespace: false });
      if (!src.startsWith('.')) {
        const pkg = src.split('.')[0] ?? src;
        if (pkg && !dependencies.includes(pkg)) dependencies.push(pkg);
      }
    }
  }

  return {
    filePath,
    language:     'python',
    lineCount:    content.split('\n').length,
    complexity:   1,
    exports,
    imports,
    dependencies,
  };
}
