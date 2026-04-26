/**
 * MCPClientRegistry — manages MCP (Model Context Protocol) server connections per-tenant (G9).
 *
 * Connects to external MCP servers (GitHub, Linear, Jira, Slack) and registers
 * their tools into the existing ToolRegistry — enabling the agent to call external
 * services via the same tool interface used for local operations.
 *
 * Gated by ISecurityContext — only tools whose scope is granted in the security
 * context are registered for a given tenant's task.
 */
import type { ISecurityContext } from '@oweibo/core-contracts';

export interface MCPServerConfig {
  /** Unique identifier for this MCP server (e.g. 'github', 'linear'). */
  readonly id: string;
  /** MCP server endpoint URL. */
  readonly url: string;
  /** Required permission scope to access this server's tools. */
  readonly requiredPermission: string;
}

export interface MCPTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  invoke(input: unknown, authToken: string): Promise<unknown>;
}

/**
 * MCPClientRegistry — per-tenant MCP server connection manager.
 * Tools from connected MCP servers are dynamically added to the in-process ToolRegistry.
 */
export class MCPClientRegistry {
  private readonly connections = new Map<string, MCPTool[]>();

  constructor(
    private readonly servers: readonly MCPServerConfig[],
    private readonly getToken: (tenantId: string, serverId: string) => Promise<string | null>,
  ) {}

  /**
   * connect — establishes connections to all MCP servers the security context permits.
   * Returns the list of tool names registered for this tenant.
   */
  async connect(tenantId: string, secCtx: ISecurityContext): Promise<string[]> {
    const registeredTools: string[] = [];

    for (const server of this.servers) {
      if (!secCtx.permissions.includes(server.requiredPermission)) continue;

      const token = await this.getToken(tenantId, server.id);
      if (!token) continue;

      try {
        const tools = await this.fetchMCPTools(server.url, token);
        const key   = `${tenantId}:${server.id}`;
        this.connections.set(key, tools);
        registeredTools.push(...tools.map(t => `${server.id}/${t.name}`));
        console.log(`[MCPClientRegistry] Connected to ${server.id} for tenant ${tenantId} — ${tools.length} tool(s) available`);
      } catch (err) {
        console.warn(`[MCPClientRegistry] Failed to connect to ${server.id}: ${(err as Error).message}`);
      }
    }

    return registeredTools;
  }

  /**
   * disconnect — closes all MCP connections for a tenant.
   * Called on task completion to release resources.
   */
  disconnect(tenantId: string): void {
    for (const server of this.servers) {
      this.connections.delete(`${tenantId}:${server.id}`);
    }
  }

  /**
   * getTools — returns all MCP tools available to a tenant.
   */
  getTools(tenantId: string): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const server of this.servers) {
      const key = `${tenantId}:${server.id}`;
      const serverTools = this.connections.get(key);
      if (serverTools) tools.push(...serverTools);
    }
    return tools;
  }

  private async fetchMCPTools(serverUrl: string, token: string): Promise<MCPTool[]> {
    // Stub: MCP protocol tool discovery via HTTP GET /tools
    // Real implementation would send a JSON-RPC 2.0 request per the MCP spec
    const response = await fetch(`${serverUrl}/tools`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error(`MCP server returned ${response.status}`);
    const data = (await response.json()) as { tools?: Array<{ name: string; description: string; inputSchema: unknown }> };
    return (data.tools ?? []).map(t => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      invoke:      async (input: unknown) => {
        const res = await fetch(`${serverUrl}/invoke/${t.name}`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`MCP tool ${t.name} returned ${res.status}`);
        return res.json();
      },
    }));
  }
}
