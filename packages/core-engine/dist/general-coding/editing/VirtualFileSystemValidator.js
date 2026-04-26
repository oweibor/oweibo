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
exports.VirtualFileSystemValidator = void 0;
// packages/core-engine/src/general-coding/editing/VirtualFileSystemValidator.ts
// Pre-flight in-memory TypeScript compilation gate (§16f.9.5, G16)
const ts_morph_1 = require("ts-morph");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * VirtualFileSystemValidator — pre-flight in-memory TypeScript compilation gate.
 *
 * G16 fix: Shifts verification from Post-Write to Pre-Write.
 * Applies proposed diffs to an in-memory VFS and runs ts-morph getPreEmitDiagnostics().
 * No files are written to disk — EditApplicator only runs when this gate passes.
 */
class VirtualFileSystemValidator {
    repoRoot;
    constructor(repoRoot) {
        this.repoRoot = repoRoot;
    }
    async validate(filesToChange, proposedContents) {
        const configPath = this.findTsConfig();
        if (!configPath)
            return { passed: true, diagnostics: [] };
        const vfsHost = new ts_morph_1.InMemoryFileSystemHost();
        const resolvedRoot = path.resolve(this.repoRoot);
        // Load existing files for all files in the plan
        for (const filePath of filesToChange) {
            const absPath = path.join(resolvedRoot, filePath);
            try {
                vfsHost.writeFileSync(absPath, fs.readFileSync(absPath, 'utf8'));
            }
            catch { /* New file — will be populated from proposedContents */ }
        }
        // Apply proposed contents onto the VFS
        for (const [filePath, content] of proposedContents) {
            vfsHost.writeFileSync(path.resolve(this.repoRoot, filePath), content);
        }
        const project = new ts_morph_1.Project({
            tsConfigFilePath: configPath,
            fileSystem: vfsHost,
            skipAddingFilesFromTsConfig: false,
            compilerOptions: { noEmit: true, skipLibCheck: true },
        });
        const tsDiagnostics = project.getPreEmitDiagnostics();
        if (tsDiagnostics.length === 0)
            return { passed: true, diagnostics: [] };
        const diagnostics = tsDiagnostics
            .filter(d => d.getSourceFile() !== undefined)
            .slice(0, 20)
            .map(d => {
            const sf = d.getSourceFile();
            const start = d.getStart() ?? 0;
            const { line, column } = sf.getLineAndColumnAtPos(start);
            return {
                filePath: path.relative(resolvedRoot, sf.getFilePath()),
                line,
                column,
                message: d.getMessageText().toString(),
                code: d.getCode(),
            };
        });
        return { passed: false, diagnostics };
    }
    findTsConfig() {
        const candidates = [
            path.join(this.repoRoot, 'tsconfig.json'),
            path.join(this.repoRoot, 'tsconfig.base.json'),
        ];
        return candidates.find(c => fs.existsSync(c)) ?? null;
    }
}
exports.VirtualFileSystemValidator = VirtualFileSystemValidator;
//# sourceMappingURL=VirtualFileSystemValidator.js.map