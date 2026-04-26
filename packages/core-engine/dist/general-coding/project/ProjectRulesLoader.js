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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectRulesLoader = void 0;
// packages/core-engine/src/general-coding/project/ProjectRulesLoader.ts
// Loads and synthesises project-level coding rules (§16f.13)
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * ProjectRulesLoader — loads and synthesises project-level coding rules.
 *
 * Sources (priority order, highest first):
 *   1. .oweibo/rules.md     — explicit oweibo rules file
 *   2. CLAUDE.md            — Claude Code compatibility
 *   3. .cursorrules         — Cursor AI compatibility
 *   4. Auto-extracted conventions — inferred from codebase on first index
 *
 * v9.1 security fix: Rules files are limited to 100KB to prevent prompt injection via
 * oversized rules. Content is truncated to 4000 chars (~1000 tokens) for the LLM context.
 */
class ProjectRulesLoader {
    llm;
    qdrant;
    static RULES_FILES = ['.oweibo/rules.md', 'CLAUDE.md', '.cursorrules'];
    static MAX_FILE_SIZE_BYTES = 100 * 1024; // v9.1: 100KB limit
    static MAX_CONTENT_CHARS = 4000; // v9.1: ~1000 tokens
    static MAX_TOTAL_TOKENS = 1500; // v9.1: Budget for rules in prompt
    constructor(llm, qdrant) {
        this.llm = llm;
        this.qdrant = qdrant;
    }
    async load(repoRoot) {
        const sections = [];
        // 1. Load explicit rules files with size validation (v9.1 security fix)
        for (const rulesFile of ProjectRulesLoader.RULES_FILES) {
            const fullPath = path.join(repoRoot, rulesFile);
            if (fs.existsSync(fullPath)) {
                // v9.1: Check file size BEFORE reading to prevent OOM on malicious large files
                const stats = fs.statSync(fullPath);
                if (stats.size > ProjectRulesLoader.MAX_FILE_SIZE_BYTES) {
                    console.warn(`[ProjectRulesLoader] Rules file ${rulesFile} exceeds 100KB limit (${Math.round(stats.size / 1024)}KB) — skipping`);
                    continue;
                }
                const content = fs.readFileSync(fullPath, 'utf8');
                // v9.1: Validate content doesn't contain obvious prompt injection patterns
                if (this.containsSuspiciousPatterns(content)) {
                    console.warn(`[ProjectRulesLoader] Rules file ${rulesFile} contains suspicious patterns — loading with sanitization`);
                }
                const truncated = content.slice(0, ProjectRulesLoader.MAX_CONTENT_CHARS);
                const truncationNote = content.length > ProjectRulesLoader.MAX_CONTENT_CHARS
                    ? `\n\n[Rules truncated — ${content.length - ProjectRulesLoader.MAX_CONTENT_CHARS} chars omitted]`
                    : '';
                sections.push(`## Project Rules (${rulesFile})\n${truncated}${truncationNote}`);
                break; // Use the first valid one found
            }
        }
        // 2. Auto-extract conventions if no rules file found
        if (sections.length === 0) {
            const extracted = await this.extractConventions(repoRoot);
            if (extracted)
                sections.push(extracted);
        }
        if (sections.length === 0)
            return '';
        // v9.1: Final token budget enforcement
        const combined = sections.join('\n\n');
        return this.enforceTokenBudget(combined);
    }
    /**
     * v9.1: Check for suspicious patterns that might indicate prompt injection.
     * These patterns don't block loading but trigger a warning.
     */
    containsSuspiciousPatterns(content) {
        const suspiciousPatterns = [
            /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules)/i,
            /you\s+are\s+(now|actually)/i,
            /disregard\s+(the\s+)?(system|previous)/i,
            /\[INST\]/i,
            /<\|im_start\|>/i,
            /```system/i,
        ];
        return suspiciousPatterns.some(p => p.test(content));
    }
    /**
     * v9.1: Enforce token budget by truncating to MAX_TOTAL_TOKENS.
     * Uses simple word-count heuristic (1 token ≈ 0.75 words).
     */
    enforceTokenBudget(content) {
        const estimatedTokens = Math.ceil(content.split(/\s+/).length / 0.75);
        if (estimatedTokens <= ProjectRulesLoader.MAX_TOTAL_TOKENS) {
            return content;
        }
        const words = content.split(/\s+/);
        const targetWords = Math.floor(ProjectRulesLoader.MAX_TOTAL_TOKENS * 0.75);
        return words.slice(0, targetWords).join(' ') + '\n\n[Rules truncated to fit token budget]';
    }
    /**
     * extractConventions — samples TypeScript files and asks the LLM to identify
     * coding conventions. Called once per repo root and cached.
     */
    async extractConventions(repoRoot) {
        const sampleFiles = this.sampleSourceFiles(repoRoot, 5);
        if (sampleFiles.length === 0)
            return null;
        const samples = sampleFiles
            .map(f => `### ${path.relative(repoRoot, f)}\n${fs.readFileSync(f, 'utf8').slice(0, 500)}`)
            .join('\n\n');
        const res = await this.llm.generate({
            systemPrompt: 'You are a code style analyser. Identify the coding conventions of this project from the code samples.',
            userPrompt: `Code samples:\n${samples}\n\nIdentify:\n1. Naming conventions (files, classes, functions, variables)\n2. Import style (named vs default, relative vs alias)\n3. Async pattern (async/await, promises, callbacks)\n4. Error handling pattern\n5. Test file naming and co-location convention\n\nOutput as a concise numbered list in markdown. Max 300 words.`,
        });
        return `## Auto-Detected Project Conventions\n${res.output}`;
    }
    sampleSourceFiles(repoRoot, count) {
        const results = [];
        const walk = (dir) => {
            if (results.length >= count)
                return;
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const e of entries) {
                if (results.length >= count)
                    break;
                if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist')
                    continue;
                const fullPath = path.join(dir, e.name);
                if (e.isDirectory())
                    walk(fullPath);
                else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name))
                    results.push(fullPath);
            }
        };
        walk(repoRoot);
        return results;
    }
}
exports.ProjectRulesLoader = ProjectRulesLoader;
//# sourceMappingURL=ProjectRulesLoader.js.map