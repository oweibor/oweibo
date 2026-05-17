"use strict";
/**
 * TypeScriptAnalyzer — deep TypeScript/JavaScript code analysis using the TS compiler API.
 *
 * Reuse boundaries (A4, v10.3):
 *   - Reads from CodeIntelligenceLayer ONLY when injected and already indexed.
 *   - Falls back to a standalone ts.createProgram when CIL is absent.
 *   - Writes to DocAnalyzerCache (NOT AstMetadataCache).
 *
 * analyzeDirectory() builds ONE ts.Program per call — 10–50× faster for large repos
 * than per-file createSourceFile.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeScriptAnalyzer = void 0;
const typescript_1 = __importDefault(require("typescript"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const SUPPORTED = ['typescript', 'javascript'];
class TypeScriptAnalyzer {
    supportedLanguages = SUPPORTED;
    async analyzeFile(filePath, content, signal) {
        signal?.throwIfAborted();
        const sourceFile = typescript_1.default.createSourceFile(filePath, content, typescript_1.default.ScriptTarget.ESNext, true);
        return extractFromSourceFile(sourceFile, filePath, content);
    }
    async analyzeDirectory(rootPath, filePaths, signal) {
        signal?.throwIfAborted();
        if (filePaths.length === 0)
            return [];
        // Read all file contents, then build a single Program
        const contentMap = new Map();
        for (const fp of filePaths) {
            signal?.throwIfAborted();
            try {
                contentMap.set(fp, await promises_1.default.readFile(fp, 'utf-8'));
            }
            catch {
                // File vanished between discovery and read — skip
            }
        }
        // Locate tsconfig.json in rootPath
        const tsconfigPath = node_path_1.default.join(rootPath, 'tsconfig.json');
        let compilerOptions = {
            target: typescript_1.default.ScriptTarget.ESNext,
            module: typescript_1.default.ModuleKind.NodeNext,
            allowJs: true,
            checkJs: false,
            noEmit: true,
        };
        try {
            await promises_1.default.access(tsconfigPath);
            const raw = typescript_1.default.readConfigFile(tsconfigPath, typescript_1.default.sys.readFile);
            if (!raw.error) {
                const parsed = typescript_1.default.parseJsonConfigFileContent(raw.config, typescript_1.default.sys, rootPath);
                compilerOptions = parsed.options;
            }
        }
        catch {
            // No tsconfig — use synthetic options
        }
        const host = typescript_1.default.createCompilerHost(compilerOptions);
        const origGetSourceFile = host.getSourceFile.bind(host);
        host.getSourceFile = (fileName, langVersion) => {
            const content = contentMap.get(fileName);
            if (content !== undefined) {
                return typescript_1.default.createSourceFile(fileName, content, langVersion, true);
            }
            return origGetSourceFile(fileName, langVersion);
        };
        const program = typescript_1.default.createProgram(Array.from(contentMap.keys()), compilerOptions, host);
        const checker = program.getTypeChecker();
        const results = [];
        for (const [fp, content] of contentMap) {
            signal?.throwIfAborted();
            const sf = program.getSourceFile(fp);
            if (!sf) {
                results.push(await this.analyzeFile(fp, content, signal));
                continue;
            }
            results.push(extractFromSourceFile(sf, fp, content, checker));
        }
        return results;
    }
    async extractCallGraph(files, signal) {
        signal?.throwIfAborted();
        const edges = [];
        // Build a symbol lookup: exportedName → filePath
        const exportMap = new Map();
        for (const f of files) {
            for (const sym of f.exports) {
                exportMap.set(sym.name, f.filePath);
            }
        }
        for (const f of files) {
            signal?.throwIfAborted();
            for (const imp of f.imports) {
                for (const sym of imp.symbols) {
                    const calleePath = exportMap.get(sym);
                    if (calleePath && calleePath !== f.filePath) {
                        edges.push({
                            callerFile: f.filePath,
                            callerSymbol: '(import)',
                            calleeFile: calleePath,
                            calleeSymbol: sym,
                            callType: 'direct',
                            line: 0,
                        });
                    }
                }
            }
        }
        return edges;
    }
    extractSymbols(files) {
        return files.flatMap((f) => f.exports);
    }
}
exports.TypeScriptAnalyzer = TypeScriptAnalyzer;
// ─── Internal extraction helpers ─────────────────────────────────────────────
function extractFromSourceFile(sf, filePath, content, checker) {
    const exports = [];
    const imports = [];
    const dependencies = [];
    let complexity = 1; // base complexity
    const moduleHash = node_crypto_1.default.createHash('sha256')
        .update(node_path_1.default.dirname(filePath))
        .digest('hex')
        .slice(0, 6);
    typescript_1.default.forEachChild(sf, (node) => {
        // ── Imports ────────────────────────────────────────────────────────────────
        if (typescript_1.default.isImportDeclaration(node)) {
            const source = node.moduleSpecifier.text;
            const symbols = [];
            let isDefault = false;
            let isNamespace = false;
            if (node.importClause) {
                if (node.importClause.name) {
                    symbols.push(node.importClause.name.text);
                    isDefault = true;
                }
                const nb = node.importClause.namedBindings;
                if (nb) {
                    if (typescript_1.default.isNamespaceImport(nb)) {
                        symbols.push(nb.name.text);
                        isNamespace = true;
                    }
                    else {
                        nb.elements.forEach((el) => symbols.push(el.name.text));
                    }
                }
            }
            imports.push({ source, symbols, isDefault, isNamespace });
            if (!source.startsWith('.') && !source.startsWith('/')) {
                const pkg = source.startsWith('@')
                    ? source.split('/').slice(0, 2).join('/')
                    : source.split('/')[0];
                if (!dependencies.includes(pkg))
                    dependencies.push(pkg);
            }
        }
        // ── Exported declarations ─────────────────────────────────────────────────
        const isExported = hasExportModifier(node);
        if (!isExported)
            return;
        if (typescript_1.default.isFunctionDeclaration(node) && node.name) {
            const sym = buildFunctionSymbol(node, filePath, moduleHash, checker, sf);
            exports.push(sym);
            complexity += countBranches(node);
        }
        else if (typescript_1.default.isClassDeclaration(node) && node.name) {
            exports.push(buildClassSymbol(node, filePath, moduleHash, checker, sf));
        }
        else if (typescript_1.default.isInterfaceDeclaration(node)) {
            exports.push(buildInterfaceSymbol(node, filePath, moduleHash, sf));
        }
        else if (typescript_1.default.isTypeAliasDeclaration(node)) {
            exports.push({
                name: node.name.text,
                kind: 'type',
                filePath,
                line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                visibility: 'public',
                moduleHash,
            });
        }
        else if (typescript_1.default.isVariableStatement(node)) {
            node.declarationList.declarations.forEach((decl) => {
                if (typescript_1.default.isIdentifier(decl.name)) {
                    exports.push({
                        name: decl.name.text,
                        kind: 'variable',
                        filePath,
                        line: sf.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
                        visibility: 'public',
                        moduleHash,
                    });
                }
            });
        }
        else if (typescript_1.default.isEnumDeclaration(node)) {
            exports.push({
                name: node.name.text,
                kind: 'enum',
                filePath,
                line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                visibility: 'public',
                moduleHash,
            });
        }
    });
    const lineCount = content.split('\n').length;
    return {
        filePath,
        language: inferLanguage(filePath),
        lineCount,
        complexity,
        exports,
        imports,
        dependencies,
    };
}
function hasExportModifier(node) {
    const mods = typescript_1.default.canHaveModifiers(node) ? typescript_1.default.getModifiers(node) : undefined;
    return mods?.some((m) => m.kind === typescript_1.default.SyntaxKind.ExportKeyword) ?? false;
}
function buildFunctionSymbol(node, filePath, moduleHash, checker, sf) {
    const name = node.name.text;
    const line = sf ? sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 : 0;
    const isAsync = node.modifiers?.some((m) => m.kind === typescript_1.default.SyntaxKind.AsyncKeyword) ?? false;
    const parameters = node.parameters.map((p) => ({
        name: typescript_1.default.isIdentifier(p.name) ? p.name.text : '(destructured)',
        type: p.type ? p.type.getText() : 'unknown',
        optional: !!p.questionToken || !!p.initializer,
        default: p.initializer?.getText(),
    }));
    const returnType = node.type?.getText() ?? (checker ? getReturnTypeText(node, checker) : undefined);
    const rawDocumentation = extractJsDoc(node);
    const decorators = extractDecorators(node);
    return {
        name, kind: 'function', filePath, line,
        visibility: 'public', isAsync, parameters, returnType,
        rawDocumentation, decorators, moduleHash,
    };
}
function buildClassSymbol(node, filePath, moduleHash, checker, sf) {
    const name = node.name.text;
    const line = sf ? sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 : 0;
    const members = [];
    node.members.forEach((member) => {
        if (!typescript_1.default.isMethodDeclaration(member) && !typescript_1.default.isPropertyDeclaration(member))
            return;
        if (!typescript_1.default.isIdentifier(member.name))
            return;
        const mods = typescript_1.default.canHaveModifiers(member) ? typescript_1.default.getModifiers(member) : undefined;
        const isPrivate = mods?.some((m) => m.kind === typescript_1.default.SyntaxKind.PrivateKeyword || m.kind === typescript_1.default.SyntaxKind.ProtectedKeyword) ?? false;
        members.push({
            name: member.name.text,
            kind: typescript_1.default.isMethodDeclaration(member) ? 'function' : 'variable',
            filePath,
            line: sf ? sf.getLineAndCharacterOfPosition(member.getStart()).line + 1 : 0,
            visibility: isPrivate ? 'private' : 'public',
            moduleHash,
        });
    });
    return {
        name, kind: 'class', filePath, line, visibility: 'public',
        rawDocumentation: extractJsDoc(node),
        decorators: extractDecorators(node),
        members, moduleHash,
    };
}
function buildInterfaceSymbol(node, filePath, moduleHash, sf) {
    return {
        name: node.name.text,
        kind: 'interface',
        filePath,
        line: sf ? sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 : 0,
        visibility: 'public',
        rawDocumentation: extractJsDoc(node),
        moduleHash,
    };
}
function getReturnTypeText(node, checker) {
    try {
        const sig = checker.getSignatureFromDeclaration(node);
        if (sig)
            return checker.typeToString(checker.getReturnTypeOfSignature(sig));
    }
    catch { /* checker may not have full info in partial programs */ }
    return undefined;
}
function extractJsDoc(node) {
    const ranges = typescript_1.default.getLeadingCommentRanges(node.getSourceFile().text, node.getFullStart());
    if (!ranges?.length)
        return undefined;
    return ranges
        .map((r) => node.getSourceFile().text.slice(r.pos, r.end).trim())
        .join('\n') || undefined;
}
function extractDecorators(node) {
    if (!typescript_1.default.canHaveDecorators(node))
        return undefined;
    const decs = typescript_1.default.getDecorators(node);
    if (!decs?.length)
        return undefined;
    return decs.map((d) => d.expression.getText());
}
function countBranches(node) {
    let count = 0;
    function visit(n) {
        switch (n.kind) {
            case typescript_1.default.SyntaxKind.IfStatement:
            case typescript_1.default.SyntaxKind.ConditionalExpression:
            case typescript_1.default.SyntaxKind.CaseClause:
            case typescript_1.default.SyntaxKind.CatchClause:
            case typescript_1.default.SyntaxKind.ForStatement:
            case typescript_1.default.SyntaxKind.ForInStatement:
            case typescript_1.default.SyntaxKind.ForOfStatement:
            case typescript_1.default.SyntaxKind.WhileStatement:
            case typescript_1.default.SyntaxKind.DoStatement:
            case typescript_1.default.SyntaxKind.AmpersandAmpersandToken:
            case typescript_1.default.SyntaxKind.BarBarToken:
            case typescript_1.default.SyntaxKind.QuestionQuestionToken:
                count++;
                break;
        }
        typescript_1.default.forEachChild(n, visit);
    }
    visit(node);
    return count;
}
function inferLanguage(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'py')
        return 'python';
    if (ext === 'go')
        return 'go';
    if (ext === 'rs')
        return 'rust';
    if (ext === 'java')
        return 'java';
    return 'typescript';
}
//# sourceMappingURL=TypeScriptAnalyzer.js.map