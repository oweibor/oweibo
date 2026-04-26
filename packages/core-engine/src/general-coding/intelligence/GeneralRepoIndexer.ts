// packages/core-engine/src/general-coding/intelligence/GeneralRepoIndexer.ts
// Qdrant indexer + chokidar watch-mode for arbitrary repos (§16f.8)
type QdrantClient = any;
import * as fs           from 'fs';
import * as path         from 'path';
import type { ILLMClient } from '@oweibo/core-contracts';

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
export class GeneralRepoIndexer {
  private static readonly VECTOR_SIZE         = 768;
  private static readonly CHUNK_OVERLAP_LINES = 10;

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly llm:    ILLMClient,  // used only for embed() calls
  ) {}

  async index(repoRoot: string, collectionName: string, tenantId: string): Promise<void> {
    const collections = await this.qdrant.getCollections();
    if (!collections.collections.find(c => c.name === collectionName)) {
      await this.qdrant.createCollection(collectionName, {
        vectors: { size: GeneralRepoIndexer.VECTOR_SIZE, distance: 'Cosine' },
      });
      // Insert metadata point for TTL tracking
      await this.qdrant.upsert(collectionName, {
        points: [{
          id:      0,
          vector:  new Array(GeneralRepoIndexer.VECTOR_SIZE).fill(0) as number[],
          payload: { _metadata: true, createdAt: Date.now(), tenantId, repoRoot },
        }],
      });
    }

    const files = this.walkRepo(repoRoot);
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const chunks  = this.chunkFile(filePath, content);
      await this.upsertChunks(collectionName, filePath, chunks, tenantId);
    }
  }

  async reindexFiles(collectionName: string, filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      await this.qdrant.delete(collectionName, {
        filter: { must: [{ key: 'filePath', match: { value: filePath } }] },
      });
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const chunks  = this.chunkFile(filePath, content);
      await this.upsertChunks(collectionName, filePath, chunks, '');
    }
  }

  /**
   * v9.1: Batched reindex — processes files sequentially to avoid memory pressure.
   */
  async reindexFilesBatched(collectionName: string, filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      await this.qdrant.delete(collectionName, {
        filter: { must: [{ key: 'filePath', match: { value: filePath } }] },
      }).catch(() => null);

      const content = await this.readFileContent(filePath);
      if (!content) continue;

      const chunks    = this.chunkFile(filePath, content);
      const tenantId  = collectionName.split(':')[1] ?? 'default';
      await this.upsertChunks(collectionName, filePath, chunks, tenantId);
    }
  }

  async search(collectionName: string, query: string, topK: number = 10): Promise<string> {
    const embedding = await this.embed(query);
    const results   = await this.qdrant.search(collectionName, {
      vector:       embedding,
      limit:        topK,
      with_payload: true,
    });
    return results
      .map(r => `### ${r.payload?.['filePath']}\n${r.payload?.['content']}`)
      .join('\n\n');
  }

  async cleanupSession(collectionName: string): Promise<void> {
    try { await this.qdrant.deleteCollection(collectionName); }
    catch { /* Collection may already be gone */ }
  }

  private walkRepo(root: string): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) walk(fullPath);
        else if (/\.(ts|tsx|js|jsx|py|go|rs|java|md|json)$/.test(e.name)) results.push(fullPath);
      }
    };
    walk(root);
    return results;
  }

  private chunkFile(filePath: string, content: string): string[] {
    const isTs = /\.(ts|tsx|js|jsx)$/.test(filePath);
    if (isTs) {
      const chunks: string[] = [];
      const lines = content.split('\n');
      let current: string[] = [];
      for (const line of lines) {
        if (/^(export )?(async function|function|class|const \w+ = (\(|async))/.test(line) && current.length > 5) {
          chunks.push(current.join('\n'));
          current = [line];
        } else {
          current.push(line);
        }
      }
      if (current.length > 0) chunks.push(current.join('\n'));
      return chunks.filter(c => c.trim().length > 0);
    }
    const lines: string[] = content.split('\n');
    const chunks: string[] = [];
    for (let i = 0; i < lines.length; i += 100 - GeneralRepoIndexer.CHUNK_OVERLAP_LINES) {
      chunks.push(lines.slice(i, i + 100).join('\n'));
    }
    return chunks;
  }

  private async upsertChunks(
    collectionName: string,
    filePath:       string,
    chunks:         string[],
    tenantId:       string,
  ): Promise<void> {
    const BATCH_SIZE = 20;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch  = chunks.slice(i, i + BATCH_SIZE);
      const points = await Promise.all(
        batch.map(async (chunk, j) => ({
          id:      this.hashId(filePath + (i + j)),
          vector:  await this.embed(chunk),
          payload: { filePath, chunkIndex: i + j, content: chunk, tenantId },
        })),
      );
      await this.qdrant.upsert(collectionName, { points });
    }
  }

  private async readFileContent(filePath: string): Promise<string | null> {
    try {
      const { readFile } = await import('fs/promises');
      return await readFile(filePath, 'utf8');
    } catch { return null; }
  }

  private async embed(text: string): Promise<number[]> {
    const res = await this.llm.generate({ systemPrompt: '', userPrompt: text, responseFormat: 'embedding' });
    return res.embedding ?? [];
  }

  private hashId(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i);
    return Math.abs(hash >>> 0);
  }
}
