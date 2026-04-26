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
exports.AstMetadataCache = void 0;
// packages/core-engine/src/general-coding/intelligence/AstMetadataCache.ts
// File-hash-keyed persistent AST cache — sub-200ms warm reindex (§16f.6b, G15)
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
/**
 * AstMetadataCache — file-hash-keyed persistent cache for CodeIntelligenceLayer.
 *
 * G15 fix: Prevents full re-parse of the entire call graph on every file change.
 * Workflow:
 *   1. On analyzeRepo() / reindexFiles(): compute SHA-256 of each file.
 *   2. If the hash matches the cached entry, skip re-parsing.
 *   3. If the hash is new or missing, re-parse and update the cache entry.
 *   4. flush() writes the updated cache map to disk atomically (tmp+rename).
 *
 * The cache is keyed by absolute file path and is invalidated per-file, not globally.
 */
class AstMetadataCache {
    repoRoot;
    cache = new Map();
    cachePath;
    dirty = false;
    constructor(repoRoot) {
        this.repoRoot = repoRoot;
        this.cachePath = path.join(repoRoot, '.oweibo', 'ast-cache.json');
    }
    load() {
        if (!fs.existsSync(this.cachePath))
            return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
            this.cache = new Map(Object.entries(raw));
        }
        catch {
            this.cache.clear(); // Corrupt cache — start fresh
        }
    }
    isStale(filePath) {
        const entry = this.cache.get(filePath);
        if (!entry)
            return true;
        return this.hashFile(filePath) !== entry.fileHash;
    }
    get(filePath) {
        return this.cache.get(filePath);
    }
    set(filePath, entry) {
        this.cache.set(filePath, {
            ...entry,
            fileHash: this.hashFile(filePath),
            lastIndexed: new Date().toISOString(),
        });
        this.dirty = true;
    }
    flush() {
        if (!this.dirty)
            return;
        const dir = path.dirname(this.cachePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = this.cachePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cache), null, 2), 'utf8');
        fs.renameSync(tmp, this.cachePath);
        this.dirty = false;
    }
    hashFile(filePath) {
        try {
            return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        }
        catch {
            return ''; // file deleted or unreadable — treat as stale
        }
    }
}
exports.AstMetadataCache = AstMetadataCache;
//# sourceMappingURL=AstMetadataCache.js.map