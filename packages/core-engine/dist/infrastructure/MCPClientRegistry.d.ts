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
export declare class MCPClientRegistry {
    private readonly servers;
    private readonly getToken;
    private readonly connections;
    constructor(servers: readonly MCPServerConfig[], getToken: (tenantId: string, serverId: string) => Promise<string | null>);
    /**
     * connect — establishes connections to all MCP servers the security context permits.
     * Returns the list of tool names registered for this tenant.
     */
    connect(tenantId: string, secCtx: ISecurityContext): Promise<string[]>;
    /**
     * disconnect — closes all MCP connections for a tenant.
     * Called on task completion to release resources.
     */
    disconnect(tenantId: string): void;
    /**
     * getTools — returns all MCP tools available to a tenant.
     */
    getTools(tenantId: string): MCPTool[];
    private fetchMCPTools;
}
//# sourceMappingURL=MCPClientRegistry.d.ts.map