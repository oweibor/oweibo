// packages/core-engine/src/tools/ToolRegistry.ts
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Ajv = require('ajv') as typeof import('ajv').default;
import type { IToolDefinition, IToolInvocationResult, ISecurityContext } from '@oweibo/core-contracts';
import { withToolSpan } from '@oweibo/observability';
import type { TaskContext } from '@oweibo/observability';

// Duck-typed Qdrant client surface — avoids direct ESM import of @qdrant/js-client-rest
type QdrantClient = {
  upsert(collection: string, args: { points: unknown[] }): Promise<unknown>;
  search(collection: string, args: { vector: number[]; limit: number; with_payload?: boolean }): Promise<Array<{ payload?: unknown }>>;
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(name: string, args: unknown): Promise<unknown>;
};

const ajv = new Ajv({ strict: false });

export class PermissionDeniedError extends Error {
  constructor(toolName: string, required: readonly string[], provided: readonly string[]) {
    super(`[ToolRegistry] Permission denied for "${toolName}". Required: [${required.join(', ')}]. Got: [${provided.join(', ')}]`);
    this.name = 'PermissionDeniedError';
  }
}

export class SchemaValidationError extends Error {
  constructor(toolName: string, direction: 'input' | 'output', detail: string) {
    super(`[ToolRegistry] ${direction} schema validation failed for "${toolName}": ${detail}`);
    this.name = 'SchemaValidationError';
  }
}

export interface ExtendedToolDefinition extends IToolDefinition {
  outputSchema?: unknown;
  allowHotReload?: boolean;
  securityContext?: { permissions: readonly string[] };
  handler?: (input: unknown) => Promise<unknown>;
}

export class ToolRegistry {
  private tools = new Map<string, ExtendedToolDefinition>();
  private readonly COLLECTION = 'tool-embeddings';

  constructor(
    private readonly qdrant: QdrantClient,
    private readonly embedFn?: (text: string) => Promise<number[]>,
  ) {}

  async register(tool: ExtendedToolDefinition): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!ajv.validateSchema(tool.inputSchema as any)) {
      throw new Error(`[ToolRegistry] Invalid input schema for tool "${tool.name}": ${ajv.errorsText()}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (tool.outputSchema && !ajv.validateSchema(tool.outputSchema as any)) {
      throw new Error(`[ToolRegistry] Invalid output schema for tool "${tool.name}": ${ajv.errorsText()}`);
    }

    if (this.tools.has(tool.name) && !tool.allowHotReload) {
      throw new Error(`[ToolRegistry] Tool "${tool.name}" already registered. Set allowHotReload=true to replace.`);
    }

    this.tools.set(tool.name, tool);

    try {
      const embedding = await this.embed(`${tool.name}: ${tool.description}`);
      await this.qdrant.upsert(this.COLLECTION, {
        points: [{ id: this.nameToId(tool.name), vector: embedding, payload: { name: tool.name } }],
      });
    } catch {
      // Qdrant unavailable at register time — tool is still usable via name lookup
    }
  }

  async semanticSearch(query: string, topK = 5): Promise<readonly IToolDefinition[]> {
    try {
      const embedding = await this.embed(query);
      const results = await this.qdrant.search(this.COLLECTION, {
        vector: embedding,
        limit: topK,
        with_payload: true,
      });
      return results
        .map(r => this.tools.get(r.payload?.['name'] as string))
        .filter((t): t is ExtendedToolDefinition => t !== undefined);
    } catch {
      // Qdrant unavailable — fall back to all registered tools
      return [...this.tools.values()].slice(0, topK);
    }
  }

  async invoke(
    name: string,
    input: unknown,
    securityContext: ISecurityContext,
    taskCtx?: TaskContext,
  ): Promise<IToolInvocationResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`[ToolRegistry] Unknown tool: "${name}"`);

    const requiredPerms = tool.securityContext?.permissions ?? [];
    const permitted = requiredPerms.every(p => securityContext.permissions.includes(p));
    if (!permitted) {
      throw new PermissionDeniedError(name, requiredPerms, securityContext.permissions);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const validate = ajv.compile(tool.inputSchema as any);
    if (!validate(input)) {
      throw new SchemaValidationError(name, 'input', ajv.errorsText(validate.errors) ?? '');
    }

    const spanCtx: TaskContext = taskCtx ?? { tenantId: '', userId: '', taskId: '' };
    const spanOpts = { toolName: name, toolType: 'function' as const };

    return withToolSpan(spanOpts, spanCtx, async () => {
      const startMs = Date.now();
      let output: unknown;
      try {
        output = tool.handler ? await tool.handler(input) : undefined;
      } catch (err) {
        return {
          toolName: name,
          status: 'error',
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
          tokensUsed: 0,
        };
      }

      if (tool.outputSchema) {
        const validateOut = ajv.compile(tool.outputSchema);
        if (!validateOut(output)) {
          throw new SchemaValidationError(name, 'output', ajv.errorsText(validateOut.errors) ?? '');
        }
      }

      return { toolName: name, status: 'success', output, durationMs: Date.now() - startMs, tokensUsed: 0 };
    });
  }

  list(): readonly IToolDefinition[] {
    return [...this.tools.values()];
  }

  private nameToId(name: string): number {
    let hash = 0;
    for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return hash;
  }

  private async embed(text: string): Promise<number[]> {
    if (this.embedFn) return this.embedFn(text);
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  }
}
