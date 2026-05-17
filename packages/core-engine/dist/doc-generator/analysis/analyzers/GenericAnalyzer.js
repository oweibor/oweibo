"use strict";
/**
 * GenericAnalyzer — line-based pattern extraction for unsupported languages.
 *
 * Handles Go, Rust, Java, YAML, JSON, Markdown and any other extension not
 * covered by a dedicated analyzer. Produces best-effort FileAnalysis with:
 *   - File-level metrics (lineCount, basic complexity)
 *   - Top-level declarations via language-specific regex
 *   - No call graph (empty EnrichedCallEdge[])
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericAnalyzer = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const SUPPORTED = ['go', 'rust', 'java', 'unknown'];
const PATTERNS = {
    go: [
        { symbol: /^func\s+(?:\(\w+\s+[*]?\w+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/m, kind: 'function', import: /^import\s+"([^"]+)"/, branch: /\b(?:if|for|switch|select|case)\b/ },
        { symbol: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/m, kind: 'class', branch: /\b(?:if|for|switch|select|case)\b/ },
    ],
    rs: [
        { symbol: /^pub\s+(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: 'function', import: /^use\s+([\w:]+)/, branch: /\b(?:if|for|while|match|loop)\b/ },
        { symbol: /^pub\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: 'class', branch: /\b(?:if|for|while|match|loop)\b/ },
        { symbol: /^pub\s+trait\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: 'interface' },
    ],
    java: [
        { symbol: /^(?:public\s+)?(?:static\s+)?(?:\w+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/m, kind: 'function', import: /^import\s+([\w.]+);/, branch: /\b(?:if|for|while|switch|catch)\b/ },
        { symbol: /^(?:public\s+)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: 'class' },
        { symbol: /^(?:public\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/m, kind: 'interface' },
    ],
};
class GenericAnalyzer {
    supportedLanguages = SUPPORTED;
    async analyzeFile(filePath, content, signal) {
        signal?.throwIfAborted();
        return analyzeContent(filePath, content);
    }
    async analyzeDirectory(_rootPath, filePaths, signal) {
        const { readFile } = await import('node:fs/promises');
        const results = [];
        for (const fp of filePaths) {
            signal?.throwIfAborted();
            try {
                const content = await readFile(fp, 'utf-8');
                results.push(analyzeContent(fp, content));
            }
            catch {
                results.push(emptyAnalysis(fp));
            }
        }
        return results;
    }
    async extractCallGraph(_files, signal) {
        signal?.throwIfAborted();
        return []; // No call graph for generic files
    }
    extractSymbols(files) {
        return files.flatMap((f) => f.exports);
    }
}
exports.GenericAnalyzer = GenericAnalyzer;
// ─── Internal helpers ─────────────────────────────────────────────────────────
function analyzeContent(filePath, content) {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const language = extToLanguage(ext);
    const moduleHash = node_crypto_1.default.createHash('sha256')
        .update(filePath.split('/').slice(0, -1).join('/'))
        .digest('hex').slice(0, 6);
    const exports = [];
    const imports = [];
    const dependencies = [];
    let complexity = 1;
    const patterns = PATTERNS[ext] ?? [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const p of patterns) {
            const symMatch = line.match(p.symbol);
            if (symMatch?.[1]) {
                exports.push({
                    name: symMatch[1],
                    kind: p.kind,
                    filePath,
                    line: i + 1,
                    visibility: 'public',
                    moduleHash,
                });
            }
            if (p.import) {
                const impMatch = line.match(p.import);
                if (impMatch?.[1]) {
                    const src = impMatch[1];
                    imports.push({ source: src, symbols: [], isDefault: false, isNamespace: false });
                    const pkg = src.split('/')[0] ?? src;
                    if (pkg && !dependencies.includes(pkg))
                        dependencies.push(pkg);
                }
            }
            if (p.branch && p.branch.test(line))
                complexity++;
        }
    }
    return {
        filePath,
        language,
        lineCount: lines.length,
        complexity,
        exports,
        imports,
        dependencies,
    };
}
function emptyAnalysis(filePath) {
    return { filePath, language: 'unknown', lineCount: 0, complexity: 1, exports: [], imports: [], dependencies: [] };
}
function extToLanguage(ext) {
    switch (ext) {
        case 'go': return 'go';
        case 'rs': return 'rust';
        case 'java': return 'java';
        default: return 'unknown';
    }
}
//# sourceMappingURL=GenericAnalyzer.js.map