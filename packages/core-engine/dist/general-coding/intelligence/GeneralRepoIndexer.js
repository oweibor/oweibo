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
exports.GeneralRepoIndexer = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * GeneralRepoIndexer — indexes an arbitrary repo into a tenant-scoped Qdrant collection.
 *
 * Collection naming: `general-repo:{tenantId}:{sessionId}`
 * Ensures two tenants can never share a collection, even with the same sessionId.
 *
 * Chunking: TypeScript/JS files are chunked by function/class body (delimiter-based).
 * Other files use fixed 100-line chunks with 10-line overlap.
 *
 * v9.1: Batched embeddings (20 per round) to reduce Qdrant round-trips.
 */
class GeneralRepoIndexer {
    qdrant;
    llm;
    static VECTOR_SIZE = 768;
    static CHUNK_OVERLAP_LINES = 10;
    constructor(qdrant, llm) {
        this.qdrant = qdrant;
        this.llm = llm;
    }
    async index(repoRoot, collectionName, tenantId) {
        const collections = await this.qdrant.getCollections();
        if (!collections.collections.find(c => c.name === collectionName)) {
            await this.qdrant.createCollection(collectionName, {
                vectors: { size: GeneralRepoIndexer.VECTOR_SIZE, distance: 'Cosine' },
            });
            // Insert metadata point for TTL tracking
            await this.qdrant.upsert(collectionName, {
                points: [{
                        id: 0,
                        vector: new Array(GeneralRepoIndexer.VECTOR_SIZE).fill(0),
                        payload: { _metadata: true, createdAt: Date.now(), tenantId, repoRoot },
                    }],
            });
        }
        const files = this.walkRepo(repoRoot);
        for (const filePath of files) {
            const content = fs.readFileSync(filePath, 'utf8');
            const chunks = this.chunkFile(filePath, content);
            await this.upsertChunks(collectionName, filePath, chunks, tenantId);
        }
    }
    async reindexFiles(collectionName, filePaths) {
        for (const filePath of filePaths) {
            await this.qdrant.delete(collectionName, {
                filter: { must: [{ key: 'filePath', match: { value: filePath } }] },
            });
            if (!fs.existsSync(filePath))
                continue;
            const content = fs.readFileSync(filePath, 'utf8');
            const chunks = this.chunkFile(filePath, content);
            await this.upsertChunks(collectionName, filePath, chunks, '');
        }
    }
    /**
     * v9.1: Batched reindex — processes files sequentially to avoid memory pressure.
     */
    async reindexFilesBatched(collectionName, filePaths) {
        for (const filePath of filePaths) {
            await this.qdrant.delete(collectionName, {
                filter: { must: [{ key: 'filePath', match: { value: filePath } }] },
            }).catch(() => null);
            const content = await this.readFileContent(filePath);
            if (!content)
                continue;
            const chunks = this.chunkFile(filePath, content);
            const tenantId = collectionName.split(':')[1] ?? 'default';
            await this.upsertChunks(collectionName, filePath, chunks, tenantId);
        }
    }
    async search(collectionName, query, topK = 10) {
        const embedding = await this.embed(query);
        const results = await this.qdrant.search(collectionName, {
            vector: embedding,
            limit: topK,
            with_payload: true,
        });
        return results
            .map(r => `### ${r.payload?.['filePath']}\n${r.payload?.['content']}`)
            .join('\n\n');
    }
    async cleanupSession(collectionName) {
        try {
            await this.qdrant.deleteCollection(collectionName);
        }
        catch { /* Collection may already be gone */ }
    }
    walkRepo(root) {
        const results = [];
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const e of entries) {
                if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist')
                    continue;
                const fullPath = path.join(dir, e.name);
                if (e.isDirectory())
                    walk(fullPath);
                else if (/\.(ts|tsx|js|jsx|py|go|rs|java|md|json)$/.test(e.name))
                    results.push(fullPath);
            }
        };
        walk(root);
        return results;
    }
    chunkFile(filePath, content) {
        const isTs = /\.(ts|tsx|js|jsx)$/.test(filePath);
        if (isTs) {
            const chunks = [];
            const lines = content.split('\n');
            let current = [];
            for (const line of lines) {
                if (/^(export )?(async function|function|class|const \w+ = (\(|async))/.test(line) && current.length > 5) {
                    chunks.push(current.join('\n'));
                    current = [line];
                }
                else {
                    current.push(line);
                }
            }
            if (current.length > 0)
                chunks.push(current.join('\n'));
            return chunks.filter(c => c.trim().length > 0);
        }
        const lines = content.split('\n');
        const chunks = [];
        for (let i = 0; i < lines.length; i += 100 - GeneralRepoIndexer.CHUNK_OVERLAP_LINES) {
            chunks.push(lines.slice(i, i + 100).join('\n'));
        }
        return chunks;
    }
    async upsertChunks(collectionName, filePath, chunks, tenantId) {
        const BATCH_SIZE = 20;
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
            const batch = chunks.slice(i, i + BATCH_SIZE);
            const points = await Promise.all(batch.map(async (chunk, j) => ({
                id: this.hashId(filePath + (i + j)),
                vector: await this.embed(chunk),
                payload: { filePath, chunkIndex: i + j, content: chunk, tenantId },
            })));
            await this.qdrant.upsert(collectionName, { points });
        }
    }
    async readFileContent(filePath) {
        try {
            const { readFile } = await import('fs/promises');
            return await readFile(filePath, 'utf8');
        }
        catch {
            return null;
        }
    }
    async embed(text) {
        const res = await this.llm.generate({ systemPrompt: '', userPrompt: text, responseFormat: 'embedding' });
        return res.embedding ?? [];
    }
    hashId(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++)
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
        return Math.abs(hash >>> 0);
    }
}
exports.GeneralRepoIndexer = GeneralRepoIndexer;
//# sourceMappingURL=GeneralRepoIndexer.js.map