/**
 * ADR-009 §3.2 — the OUTBOUND MCP tool surface. Exactly three tools, projected
 * as ONE connector regardless of what the tenant has installed (§1: "mount
 * Oweibo as a single connector").
 *
 * These are AUTHORED CONSTANTS (INV-11). They MUST NEVER be templated from
 * connector manifests, document titles, or any source-derived string — a tool
 * description is model-facing text, and source-derived text there is prompt
 * injection with a protocol wrapper. The frozen-surface CI check
 * (toolSurface.test.ts) deep-equals the served list against this constant.
 */

/** The per-tool authorization scope. Absence of a scope is denial (§3.3). */
export type McpScope = 'oweibo:search' | 'oweibo:fetch' | 'oweibo:act';

export interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly requiredScope: McpScope;
}

const SEARCH: McpToolDef = {
  name: 'oweibo.search',
  description:
    'Permission-filtered search across the tenant\'s connected knowledge sources. ' +
    'Returns ranked results, each with a citation identifying its source and revision. ' +
    'Results are the caller\'s own permitted content only.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'The natural-language search query.' },
      // A source filter NARROWS the negotiated set; it can never widen it, and
      // it cannot reach a connector the tenant has disabled (§3.2 rule 3).
      source: { type: 'string', description: 'Optional: restrict to one source (e.g. "google_drive").' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10).' },
    },
  },
  requiredScope: 'oweibo:search',
};

const FETCH: McpToolDef = {
  name: 'oweibo.fetch',
  description:
    'Resolve a citation returned by oweibo.search to its content. ' +
    'Returns the same citation envelope alongside the content. ' +
    'A denied fetch and a nonexistent object return the same error (no existence oracle).',
  inputSchema: {
    type: 'object',
    required: ['knowledgeObjectId'],
    additionalProperties: false,
    properties: {
      knowledgeObjectId: { type: 'string', description: 'The citation id from a search result.' },
    },
  },
  requiredScope: 'oweibo:fetch',
};

const ACT: McpToolDef = {
  name: 'oweibo.act',
  description:
    'Propose or execute a governed action against a connected system. ' +
    'Returns the trust-ladder verdict (allowed / needs approval / denied), never a raw source response. ' +
    'The action\'s class is determined by the connector capability, not by the caller\'s arguments.',
  inputSchema: {
    type: 'object',
    required: ['capabilityId', 'arguments'],
    additionalProperties: false,
    properties: {
      capabilityId: { type: 'string', description: 'The connector capability to invoke.' },
      arguments: { type: 'object', description: 'Machine-readable action arguments.' },
    },
  },
  requiredScope: 'oweibo:act',
};

/**
 * The frozen roster. Order and content are the contract; the CI check pins it.
 * Adding a tool is a §6 operational-default change; the single-surface
 * PROJECTION rule (one connector, stable across installs) is §1 Fixed contract.
 */
export const OUTBOUND_TOOL_SURFACE: readonly McpToolDef[] = [SEARCH, FETCH, ACT];

/** The tools/list projection an external client sees. Identical for every tenant. */
export function listTools(): readonly Omit<McpToolDef, 'requiredScope'>[] {
  return OUTBOUND_TOOL_SURFACE.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export function toolByName(name: string): McpToolDef | undefined {
  return OUTBOUND_TOOL_SURFACE.find((t) => t.name === name);
}
