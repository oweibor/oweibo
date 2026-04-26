import type { GeneralRepoIndexer } from './GeneralRepoIndexer.js';
import type { AstMetadataCache } from './AstMetadataCache.js';
export interface SymbolDefinition {
    name: string;
    kind: 'function' | 'class' | 'interface' | 'variable' | 'type';
    filePath: string;
    line: number;
}
export interface CallEdge {
    callerFile: string;
    callerSymbol: string;
    calleeFile: string;
    calleeSymbol: string;
}
export interface ImpactReport {
    changedSymbol: string;
    affectedFiles: string[];
    affectedSymbols: string[];
    riskLevel: 'low' | 'medium' | 'high';
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
export declare class CodeIntelligenceLayer {
    private readonly repoRoot;
    private readonly indexer;
    private readonly collectionName;
    private readonly astCache;
    private program;
    private callGraph;
    private symbolIndex;
    private watcher;
    private builderProgram;
    private compilerHost;
    constructor(repoRoot: string, indexer: GeneralRepoIndexer, collectionName: string, astCache?: AstMetadataCache | null);
    analyzeRepo(): Promise<void>;
    impactOf(symbolName: string): ImpactReport;
    /**
     * v9.1: Debounced at 2s, batch cap 10 files per cycle.
     */
    watchAndReindex(): void;
    stopWatcher(): void;
    /**
     * findImporters — returns all files that directly import the given file.
     * Used by VerificationRunner for import-graph-based test targeting.
     */
    findImporters(filePath: string): string[];
    private reindexFiles;
    private visitNode;
    private getEnclosingSymbolName;
}
//# sourceMappingURL=CodeIntelligenceLayer.d.ts.map