"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArchitectureInferrer = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * ArchitectureInferrer — detects monorepo package boundaries and computes
 * inter-module coupling from import graph heuristics.
 *
 * Heuristic phase (always runs):
 *   - Detect package.json boundaries
 *   - Cross-validate against pnpm-workspace.yaml / lerna.json
 *   - Detect barrel index.ts as public API entry points
 *   - Compute coupling via import graph
 *
 * LLM phase (skipped when skipLLM=true):
 *   - 1–2 sentence module description
 *   - Purpose classification
 */
class ArchitectureInferrer {
    logger;
    options;
    constructor(logger, options = {}) {
        this.logger = logger;
        this.options = options;
    }
    async infer(rootPath, files, signal) {
        signal?.throwIfAborted();
        const packageJsonPaths = await this.findPackageJsons(rootPath);
        const workspaceGlobs = await this.loadWorkspaceGlobs(rootPath);
        const boundaries = await this.buildBoundaries(packageJsonPaths, workspaceGlobs, files);
        return boundaries;
    }
    async findPackageJsons(rootPath) {
        const results = [];
        const EXCLUDE = /node_modules|\/dist\//;
        async function walk(dir, depth) {
            if (depth > 6)
                return;
            let entries;
            try {
                entries = await promises_1.default.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const full = node_path_1.default.join(dir, entry.name);
                if (EXCLUDE.test(full))
                    continue;
                if (entry.isFile() && entry.name === 'package.json') {
                    results.push(full);
                }
                else if (entry.isDirectory()) {
                    await walk(full, depth + 1);
                }
            }
        }
        await walk(rootPath, 0);
        return results;
    }
    async loadWorkspaceGlobs(rootPath) {
        // pnpm-workspace.yaml
        try {
            const raw = await promises_1.default.readFile(node_path_1.default.join(rootPath, 'pnpm-workspace.yaml'), 'utf-8');
            const match = raw.match(/packages:\s*([\s\S]*?)(?:\n\w|\n$|$)/);
            if (match) {
                return match[1]
                    .split('\n')
                    .map((l) => l.trim().replace(/^-\s*/, '').replace(/['"]/g, ''))
                    .filter(Boolean);
            }
        }
        catch { /* no pnpm-workspace.yaml */ }
        // lerna.json
        try {
            const raw = await promises_1.default.readFile(node_path_1.default.join(rootPath, 'lerna.json'), 'utf-8');
            const json = JSON.parse(raw);
            return json.packages ?? [];
        }
        catch { /* no lerna.json */ }
        return [];
    }
    async buildBoundaries(packageJsonPaths, workspaceGlobs, files) {
        const boundaries = [];
        for (const pkgJsonPath of packageJsonPaths) {
            const pkgRoot = node_path_1.default.dirname(pkgJsonPath);
            let name = node_path_1.default.basename(pkgRoot);
            let version;
            try {
                const raw = await promises_1.default.readFile(pkgJsonPath, 'utf-8');
                const pkg = JSON.parse(raw);
                if (pkg.name)
                    name = pkg.name;
                version = pkg.version;
            }
            catch { /* keep basename fallback */ }
            const inWorkspace = workspaceGlobs.length === 0 ||
                workspaceGlobs.some((g) => this.globMatches(g, pkgRoot));
            const pkgFiles = files.filter((f) => f.filePath.startsWith(pkgRoot));
            const entryPoints = pkgFiles
                .filter((f) => /index\.(ts|tsx|js|mjs)$/.test(f.filePath))
                .map((f) => f.filePath);
            const dependsOn = this.computeDependsOn(pkgFiles, boundaries.map((b) => b.name));
            boundaries.push({
                name,
                rootPath: pkgRoot,
                version,
                inWorkspace,
                confidence: inWorkspace ? 0.9 : 0.5,
                entryPoints,
                purpose: this.inferPurpose(name, pkgFiles),
                description: '',
                fileCount: pkgFiles.length,
                dependsOn,
            });
        }
        return boundaries;
    }
    computeDependsOn(pkgFiles, knownModules) {
        const deps = new Set();
        for (const f of pkgFiles) {
            for (const imp of f.imports) {
                for (const known of knownModules) {
                    if (imp.source.includes(known) || imp.source === known)
                        deps.add(known);
                }
            }
        }
        return Array.from(deps);
    }
    inferPurpose(name, files) {
        const n = name.toLowerCase();
        if (/infra|database|db|redis|queue|storage|cache/.test(n))
            return 'infrastructure';
        if (/domain|model|entity|aggregate/.test(n))
            return 'domain';
        if (/adapter|gateway|client|integration/.test(n))
            return 'integration';
        if (/util|helper|common|shared|lib/.test(n))
            return 'utility';
        if (files.some((f) => f.exports.some((s) => s.kind === 'class' && /Service|Orchestrator|Engine/.test(s.name)))) {
            return 'core';
        }
        return 'unknown';
    }
    globMatches(glob, filePath) {
        const pattern = glob.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
        try {
            return new RegExp(pattern).test(filePath.replace(/\\/g, '/'));
        }
        catch {
            return false;
        }
    }
}
exports.ArchitectureInferrer = ArchitectureInferrer;
//# sourceMappingURL=ArchitectureInferrer.js.map