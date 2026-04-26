// packages/core-engine/src/general-coding/intelligence/CodeIntelligenceLayer.ts
// TypeScript compiler API: call graph, impact analysis, symbols (§16f.6)
import * as ts       from 'typescript';
import * as path     from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { GeneralRepoIndexer } from './GeneralRepoIndexer.js';
import type { AstMetadataCache } from './AstMetadataCache.js';

export interface SymbolDefinition {
  name:     string;
  kind:     'function' | 'class' | 'interface' | 'variable' | 'type';
  filePath: string;
  line:     number;
}

export interface CallEdge {
  callerFile:   string;
  callerSymbol: string;
  calleeFile:   string;
  calleeSymbol: string;
}

export interface ImpactReport {
  changedSymbol:   string;
  affectedFiles:   string[];
  affectedSymbols: string[];
  riskLevel:       'low' | 'medium' | 'high';
}

/**
 * CodeIntelligenceLayer — TypeScript compiler API for accurate, type-aware codebase analysis.
 *
 * Provides:
 *   - analyzeRepo(): builds call graph and symbol index from TS AST
 *   - impactOf(symbolName): all files/symbols affected by a change
 *   - watchAndReindex(): chokidar watcher for incremental re-indexing (G1)
 *
 * G15 fix: Accepts optional AstMetadataCache to skip re-parsing of unchanged files.
 * v9.1: Uses incremental builder program; debounce 2s; batch cap 10 files per cycle.
 */
export class CodeIntelligenceLayer {
  private program!: ts.Program;
  private callGraph:   Map<string, CallEdge[]>      = new Map();  // callee → callers
  private symbolIndex: Map<string, SymbolDefinition> = new Map();
  private watcher:     FSWatcher | null              = null;

  // v9.1: Incremental compiler state
  private builderProgram: ts.BuilderProgram | null = null;
  private compilerHost:   ts.CompilerHost | null   = null;

  constructor(
    private readonly repoRoot:       string,
    private readonly indexer:        GeneralRepoIndexer,
    private readonly collectionName: string,
    private readonly astCache:       AstMetadataCache | null = null, // G15: optional cache
  ) {
    this.astCache?.load();
  }

  async analyzeRepo(): Promise<void> {
    const configPath = ts.findConfigFile(this.repoRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error(`[CodeIntelligenceLayer] No tsconfig.json found in ${this.repoRoot}`);

    const config       = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));

    this.program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
    const checker = this.program.getTypeChecker();

    this.callGraph.clear();
    this.symbolIndex.clear();

    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      if (!sourceFile.fileName.startsWith(this.repoRoot)) continue;

      // G15: skip re-parse if cache is warm for this file
      if (this.astCache && !this.astCache.isStale(sourceFile.fileName)) continue;

      ts.forEachChild(sourceFile, node => this.visitNode(node, sourceFile, checker));
    }

    this.astCache?.flush();
  }

  impactOf(symbolName: string): ImpactReport {
    const callers        = this.callGraph.get(symbolName) ?? [];
    const affectedFiles  = [...new Set(callers.map(e => e.callerFile))];
    const affectedSymbols = callers.map(e => `${e.callerFile}::${e.callerSymbol}`);
    return {
      changedSymbol:  symbolName,
      affectedFiles,
      affectedSymbols,
      riskLevel: affectedFiles.length > 10 ? 'high' : affectedFiles.length > 3 ? 'medium' : 'low',
    };
  }

  /**
   * v9.1: Debounced at 2s, batch cap 10 files per cycle.
   */
  watchAndReindex(): void {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingFiles   = new Set<string>();
    let isProcessing     = false;
    const MAX_FILES_PER_BATCH = 10;
    const DEBOUNCE_MS         = 2000;

    const processBatch = async () => {
      if (isProcessing || pendingFiles.size === 0) return;
      isProcessing = true;
      try {
        const files: string[] = [];
        for (const f of pendingFiles) {
          files.push(f);
          pendingFiles.delete(f);
          if (files.length >= MAX_FILES_PER_BATCH) break;
        }
        await this.reindexFiles(files);
        await this.indexer.reindexFilesBatched(this.collectionName, files);
        if (pendingFiles.size > 0) setTimeout(processBatch, 1000);
      } finally {
        isProcessing = false;
      }
    };

    this.watcher = chokidar.watch(
      [`${this.repoRoot}/**/*.ts`, `${this.repoRoot}/**/*.tsx`],
      { ignoreInitial: true, ignored: /node_modules|\.git|dist/ },
    );

    this.watcher.on('change', (filePath: string) => {
      pendingFiles.add(filePath);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(processBatch, DEBOUNCE_MS);
    });
  }

  stopWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * findImporters — returns all files that directly import the given file.
   * Used by VerificationRunner for import-graph-based test targeting.
   */
  findImporters(filePath: string): string[] {
    const importers: string[] = [];
    for (const edges of this.callGraph.values()) {
      for (const edge of edges) {
        if (edge.calleeFile === filePath && !importers.includes(edge.callerFile)) {
          importers.push(edge.callerFile);
        }
      }
    }
    return importers;
  }

  private async reindexFiles(filePaths: string[]): Promise<void> {
    const configPath = ts.findConfigFile(this.repoRoot, ts.sys.fileExists, 'tsconfig.json')!;
    const config       = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));

    // G15: skip files that are cache-warm
    const filesToReparse = this.astCache
      ? filePaths.filter(fp => this.astCache!.isStale(fp))
      : filePaths;
    if (filesToReparse.length === 0) return;

    if (!this.compilerHost) {
      this.compilerHost = ts.createIncrementalCompilerHost(parsedConfig.options);
    }

    this.builderProgram = ts.createIncrementalProgram({
      rootNames: parsedConfig.fileNames,
      options:   parsedConfig.options,
      host:      this.compilerHost,
      ...(this.builderProgram ? { oldProgram: this.builderProgram } : {}),
    });

    this.program       = this.builderProgram.getProgram();
    const checker      = this.program.getTypeChecker();

    // Clear old call graph entries for changed files
    for (const filePath of filesToReparse) {
      for (const [callee, edges] of this.callGraph) {
        this.callGraph.set(callee, edges.filter(e => e.callerFile !== filePath));
      }
    }

    for (const filePath of filesToReparse) {
      const sourceFile = this.program.getSourceFile(filePath);
      if (sourceFile) ts.forEachChild(sourceFile, node => this.visitNode(node, sourceFile, checker));
    }

    this.astCache?.flush();
  }

  private visitNode(node: ts.Node, sourceFile: ts.SourceFile, checker: ts.TypeChecker): void {
    const filePath = sourceFile.fileName;

    if (ts.isFunctionDeclaration(node) && node.name) {
      this.symbolIndex.set(node.name.text, {
        name: node.name.text, kind: 'function', filePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line,
      });
    }
    if (ts.isClassDeclaration(node) && node.name) {
      this.symbolIndex.set(node.name.text, {
        name: node.name.text, kind: 'class', filePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line,
      });
    }

    if (ts.isCallExpression(node)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol) {
        const calleeName   = symbol.getName();
        const calleeDecl   = symbol.declarations?.[0];
        const calleeFile   = calleeDecl?.getSourceFile().fileName ?? '';
        const callerSymbol = this.getEnclosingSymbolName(node, checker) ?? '<module>';

        const edge: CallEdge = { callerFile: filePath, callerSymbol, calleeFile, calleeSymbol: calleeName };
        const existing       = this.callGraph.get(calleeName) ?? [];
        this.callGraph.set(calleeName, [...existing, edge]);
      }
    }

    ts.forEachChild(node, child => this.visitNode(child, sourceFile, checker));
  }

  private getEnclosingSymbolName(node: ts.Node, _checker: ts.TypeChecker): string | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
      if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
      if (ts.isArrowFunction(current)) {
        const parent = current.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      }
      current = current.parent;
    }
    return null;
  }
}
