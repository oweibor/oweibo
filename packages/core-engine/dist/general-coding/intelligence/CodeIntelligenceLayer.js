"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeIntelligenceLayer = void 0;
// packages/core-engine/src/general-coding/intelligence/CodeIntelligenceLayer.ts
// TypeScript compiler API: call graph, impact analysis, symbols (§16f.6)
const ts = __importStar(require("typescript"));
const path = __importStar(require("path"));
const chokidar_1 = __importDefault(require("chokidar"));
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
class CodeIntelligenceLayer {
    repoRoot;
    indexer;
    collectionName;
    astCache;
    program;
    callGraph = new Map(); // callee → callers
    symbolIndex = new Map();
    watcher = null;
    // v9.1: Incremental compiler state
    builderProgram = null;
    compilerHost = null;
    constructor(repoRoot, indexer, collectionName, astCache = null) {
        this.repoRoot = repoRoot;
        this.indexer = indexer;
        this.collectionName = collectionName;
        this.astCache = astCache;
        this.astCache?.load();
    }
    async analyzeRepo() {
        const configPath = ts.findConfigFile(this.repoRoot, ts.sys.fileExists, 'tsconfig.json');
        if (!configPath)
            throw new Error(`[CodeIntelligenceLayer] No tsconfig.json found in ${this.repoRoot}`);
        const config = ts.readConfigFile(configPath, ts.sys.readFile);
        const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
        this.program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
        const checker = this.program.getTypeChecker();
        this.callGraph.clear();
        this.symbolIndex.clear();
        for (const sourceFile of this.program.getSourceFiles()) {
            if (sourceFile.isDeclarationFile)
                continue;
            if (!sourceFile.fileName.startsWith(this.repoRoot))
                continue;
            // G15: skip re-parse if cache is warm for this file
            if (this.astCache && !this.astCache.isStale(sourceFile.fileName))
                continue;
            ts.forEachChild(sourceFile, node => this.visitNode(node, sourceFile, checker));
        }
        this.astCache?.flush();
    }
    impactOf(symbolName) {
        const callers = this.callGraph.get(symbolName) ?? [];
        const affectedFiles = [...new Set(callers.map(e => e.callerFile))];
        const affectedSymbols = callers.map(e => `${e.callerFile}::${e.callerSymbol}`);
        return {
            changedSymbol: symbolName,
            affectedFiles,
            affectedSymbols,
            riskLevel: affectedFiles.length > 10 ? 'high' : affectedFiles.length > 3 ? 'medium' : 'low',
        };
    }
    /**
     * v9.1: Debounced at 2s, batch cap 10 files per cycle.
     */
    watchAndReindex() {
        let debounceTimer = null;
        const pendingFiles = new Set();
        let isProcessing = false;
        const MAX_FILES_PER_BATCH = 10;
        const DEBOUNCE_MS = 2000;
        const processBatch = async () => {
            if (isProcessing || pendingFiles.size === 0)
                return;
            isProcessing = true;
            try {
                const files = [];
                for (const f of pendingFiles) {
                    files.push(f);
                    pendingFiles.delete(f);
                    if (files.length >= MAX_FILES_PER_BATCH)
                        break;
                }
                await this.reindexFiles(files);
                await this.indexer.reindexFilesBatched(this.collectionName, files);
                if (pendingFiles.size > 0)
                    setTimeout(processBatch, 1000);
            }
            finally {
                isProcessing = false;
            }
        };
        this.watcher = chokidar_1.default.watch([`${this.repoRoot}/**/*.ts`, `${this.repoRoot}/**/*.tsx`], { ignoreInitial: true, ignored: /node_modules|\.git|dist/ });
        this.watcher.on('change', (filePath) => {
            pendingFiles.add(filePath);
            if (debounceTimer)
                clearTimeout(debounceTimer);
            debounceTimer = setTimeout(processBatch, DEBOUNCE_MS);
        });
    }
    stopWatcher() {
        this.watcher?.close();
        this.watcher = null;
    }
    /**
     * findImporters — returns all files that directly import the given file.
     * Used by VerificationRunner for import-graph-based test targeting.
     */
    findImporters(filePath) {
        const importers = [];
        for (const edges of this.callGraph.values()) {
            for (const edge of edges) {
                if (edge.calleeFile === filePath && !importers.includes(edge.callerFile)) {
                    importers.push(edge.callerFile);
                }
            }
        }
        return importers;
    }
    async reindexFiles(filePaths) {
        const configPath = ts.findConfigFile(this.repoRoot, ts.sys.fileExists, 'tsconfig.json');
        const config = ts.readConfigFile(configPath, ts.sys.readFile);
        const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
        // G15: skip files that are cache-warm
        const filesToReparse = this.astCache
            ? filePaths.filter(fp => this.astCache.isStale(fp))
            : filePaths;
        if (filesToReparse.length === 0)
            return;
        if (!this.compilerHost) {
            this.compilerHost = ts.createIncrementalCompilerHost(parsedConfig.options);
        }
        this.builderProgram = ts.createIncrementalProgram({
            rootNames: parsedConfig.fileNames,
            options: parsedConfig.options,
            host: this.compilerHost,
            ...(this.builderProgram ? { oldProgram: this.builderProgram } : {}),
        });
        this.program = this.builderProgram.getProgram();
        const checker = this.program.getTypeChecker();
        // Clear old call graph entries for changed files
        for (const filePath of filesToReparse) {
            for (const [callee, edges] of this.callGraph) {
                this.callGraph.set(callee, edges.filter(e => e.callerFile !== filePath));
            }
        }
        for (const filePath of filesToReparse) {
            const sourceFile = this.program.getSourceFile(filePath);
            if (sourceFile)
                ts.forEachChild(sourceFile, node => this.visitNode(node, sourceFile, checker));
        }
        this.astCache?.flush();
    }
    visitNode(node, sourceFile, checker) {
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
                const calleeName = symbol.getName();
                const calleeDecl = symbol.declarations?.[0];
                const calleeFile = calleeDecl?.getSourceFile().fileName ?? '';
                const callerSymbol = this.getEnclosingSymbolName(node, checker) ?? '<module>';
                const edge = { callerFile: filePath, callerSymbol, calleeFile, calleeSymbol: calleeName };
                const existing = this.callGraph.get(calleeName) ?? [];
                this.callGraph.set(calleeName, [...existing, edge]);
            }
        }
        ts.forEachChild(node, child => this.visitNode(child, sourceFile, checker));
    }
    getEnclosingSymbolName(node, _checker) {
        let current = node.parent;
        while (current) {
            if (ts.isFunctionDeclaration(current) && current.name)
                return current.name.text;
            if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name))
                return current.name.text;
            if (ts.isArrowFunction(current)) {
                const parent = current.parent;
                if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
                    return parent.name.text;
            }
            current = current.parent;
        }
        return null;
    }
}
exports.CodeIntelligenceLayer = CodeIntelligenceLayer;
//# sourceMappingURL=CodeIntelligenceLayer.js.map