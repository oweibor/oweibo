// packages/core-engine/src/tools/ToolPerformanceTracker.ts
// Duck-typed Qdrant client surface — avoids direct ESM import of @qdrant/js-client-rest
type QdrantClient = {
  upsert(collection: string, args: { points: unknown[] }): Promise<unknown>;
  search(collection: string, args: { vector: number[]; limit: number; with_payload?: boolean; filter?: unknown }): Promise<Array<{ payload?: unknown }>>;
};

export interface ToolPerformanceRecord {
  toolName: string;
  taskContext: string;
  success: boolean;
  durationMs: number;
  errorCode?: string;
  timestamp: number;
}

export class ToolPerformanceTracker {
  private readonly COLLECTION = 'tool-performance';

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly embedFn: (text: string) => Promise<number[]>,
  ) {}

  async record(rec: ToolPerformanceRecord): Promise<void> {
    try {
      const vector = await this.embedFn(`${rec.toolName} ${rec.taskContext}`);
      await this.qdrant.upsert(this.COLLECTION, {
        points: [{ id: `${rec.toolName}-${rec.timestamp}`, vector, payload: rec as unknown as Record<string, unknown> }],
      });
    } catch {
      // Non-fatal — performance tracking should never break the tool call
    }
  }

  async rankForContext(query: string, candidates: string[], topK = 5): Promise<string[]> {
    try {
      const vector = await this.embedFn(query);
      const results = await this.qdrant.search(this.COLLECTION, {
        vector,
        limit: 200,
        with_payload: true,
        filter: { must: [{ key: 'toolName', match: { any: candidates } }] },
      });

      const scores: Record<string, { successes: number; total: number }> = {};
      for (const r of results) {
        const p = r.payload as Record<string, unknown>;
        const toolName = p['toolName'] as string | undefined;
        const success = p['success'] as boolean | undefined;
        if (!toolName) continue;
        if (!scores[toolName]) scores[toolName] = { successes: 0, total: 0 };
        scores[toolName].total++;
        if (success) scores[toolName].successes++;
      }

      return candidates
        .sort((a, b) => {
          const ra = (scores[a]?.successes ?? 0) / (scores[a]?.total ?? 1);
          const rb = (scores[b]?.successes ?? 0) / (scores[b]?.total ?? 1);
          return rb - ra;
        })
        .slice(0, topK);
    } catch {
      return candidates.slice(0, topK);
    }
  }
}
