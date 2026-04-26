"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPClientRegistry = void 0;
/**
 * MCPClientRegistry — per-tenant MCP server connection manager.
 * Tools from connected MCP servers are dynamically added to the in-process ToolRegistry.
 */
class MCPClientRegistry {
    servers;
    getToken;
    connections = new Map();
    constructor(servers, getToken) {
        this.servers = servers;
        this.getToken = getToken;
    }
    /**
     * connect — establishes connections to all MCP servers the security context permits.
     * Returns the list of tool names registered for this tenant.
     */
    async connect(tenantId, secCtx) {
        const registeredTools = [];
        for (const server of this.servers) {
            if (!secCtx.permissions.includes(server.requiredPermission))
                continue;
            const token = await this.getToken(tenantId, server.id);
            if (!token)
                continue;
            try {
                const tools = await this.fetchMCPTools(server.url, token);
                const key = `${tenantId}:${server.id}`;
                this.connections.set(key, tools);
                registeredTools.push(...tools.map(t => `${server.id}/${t.name}`));
                console.log(`[MCPClientRegistry] Connected to ${server.id} for tenant ${tenantId} — ${tools.length} tool(s) available`);
            }
            catch (err) {
                console.warn(`[MCPClientRegistry] Failed to connect to ${server.id}: ${err.message}`);
            }
        }
        return registeredTools;
    }
    /**
     * disconnect — closes all MCP connections for a tenant.
     * Called on task completion to release resources.
     */
    disconnect(tenantId) {
        for (const server of this.servers) {
            this.connections.delete(`${tenantId}:${server.id}`);
        }
    }
    /**
     * getTools — returns all MCP tools available to a tenant.
     */
    getTools(tenantId) {
        const tools = [];
        for (const server of this.servers) {
            const key = `${tenantId}:${server.id}`;
            const serverTools = this.connections.get(key);
            if (serverTools)
                tools.push(...serverTools);
        }
        return tools;
    }
    async fetchMCPTools(serverUrl, token) {
        // Stub: MCP protocol tool discovery via HTTP GET /tools
        // Real implementation would send a JSON-RPC 2.0 request per the MCP spec
        const response = await fetch(`${serverUrl}/tools`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        if (!response.ok)
            throw new Error(`MCP server returned ${response.status}`);
        const data = (await response.json());
        return (data.tools ?? []).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            invoke: async (input) => {
                const res = await fetch(`${serverUrl}/invoke/${t.name}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(input),
                });
                if (!res.ok)
                    throw new Error(`MCP tool ${t.name} returned ${res.status}`);
                return res.json();
            },
        }));
    }
}
exports.MCPClientRegistry = MCPClientRegistry;
//# sourceMappingURL=MCPClientRegistry.js.map