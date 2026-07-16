/**
 * ADR-009 §3 — the OUTBOUND MCP server face. The fabric, mountable by an
 * external MCP client as a single connector (§1).
 *
 * The face is a CALLER, never a bypass (§1). It obtains results only by calling
 * the shipped planner → retrieval → action path (injected here as `retrieve` /
 * `fetch` / `act`). It holds NO SQL, NO ACL logic, and NO connector-port access,
 * so INV-2 (ACL before ranking), INV-3 (Critical never cached), INV-4 (storage
 * compliance), and INV-11 (content is data) hold BY CONSTRUCTION — there is no
 * code path in the face in which to violate them.
 *
 * Request pipeline, order fixed and cheap-first (§3.5):
 *   authn → authz → rate limit → quota → delegate → envelope
 *
 * Tenant is ALWAYS derived from the token, NEVER from a client argument (§3.3):
 * an accepted `tenantId` parameter is a cross-tenant read waiting for a typo.
 */
import { listTools, toolByName, type McpScope } from './toolSurface.js';

// ── The bearer identity the transport resolves (§3.3) ────────────────────
export interface McpPrincipalBinding {
  readonly tenantId: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly scopes: readonly McpScope[];
  /** The principal's per-source refs (from ADR-002 canonicalFor), NEVER from the client. */
  readonly principalRefs: readonly string[];
}

// ── JSON-RPC 2.0 error codes this face uses (§3.3) ───────────────────────
export const MCP_ERR = {
  UNAUTHENTICATED: -32001,
  SCOPE_DENIED: -32003,
  RATE_LIMITED: -32005,
  BAD_REQUEST: -32602,
  INTERNAL: -32603,
} as const;

export interface McpError {
  readonly code: number;
  readonly message: string;
  /** retryAfterMs on rate-limit; deliberately never carries detail on auth failures (§3.3). */
  readonly retryAfterMs?: number;
}

export type McpResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: McpError };

// A citation-bearing search hit. Provenance is mandatory (§3.2 rule 5): a hit
// without it is dropped, not returned uncited.
export interface McpSearchHit {
  readonly knowledgeObjectId: string;
  readonly source: string;
  readonly snippet: string;
  readonly citation: {
    readonly knowledgeObjectId: string;
    readonly source: string;
    readonly indexGeneration?: number | string;
    readonly sourceRevision?: number | string;
  };
}

export interface McpFetchResult {
  readonly knowledgeObjectId: string;
  readonly content: string;
  readonly citation: McpSearchHit['citation'];
  /** §3.7: an ADR-010 withhold is surfaced as a withhold, NEVER an empty result. */
  readonly withheld?: boolean;
}

export interface McpActResult {
  readonly verdict: 'allowed' | 'needs_approval' | 'denied';
  readonly reference?: string;
}

// ── Injected collaborators (the shipped path; battery wires the real ones) ──
export interface McpRateLimiter {
  tryConsume(key: { tenantId: string; principalId: string; clientId: string }):
    Promise<{ kind: 'allowed' } | { kind: 'soft' } | { kind: 'hard'; retryAfterMs?: number }>;
}
export interface McpQuota {
  preflight(args: { tenantId: string; tool: string }):
    Promise<{ kind: 'allow' | 'soft_warn' } | { kind: 'deny'; resetAtMs?: number }>;
  record(args: { tenantId: string; tool: string; dedupeKey: string }): Promise<void>;
}

export interface McpBackend {
  /** Calls the planner→retrieval path over the tenant's ENABLED connectors (§3.2 rule 3). */
  search(args: {
    binding: McpPrincipalBinding;
    query: string;
    source?: string;
    limit: number;
  }): Promise<readonly McpSearchHit[]>;
  fetch(args: {
    binding: McpPrincipalBinding;
    knowledgeObjectId: string;
  }): Promise<McpFetchResult | { readonly notFoundOrDenied: true }>;
  act(args: {
    binding: McpPrincipalBinding;
    capabilityId: string;
    arguments: Readonly<Record<string, unknown>>;
  }): Promise<McpActResult>;
}

export interface McpFaceOptions {
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
}

/** The ONE error whose message is client-facing: identical for denied and nonexistent (§3.3). */
class McpNotFoundError extends Error {
  constructor() {
    super('not found');
  }
}

function isCredentialShaped(key: string): boolean {
  return /token|secret|password|api[_-]?key|private[_-]?key|authorization|bearer|credential/i.test(key);
}

/** Deep scan asserting no credential-shaped field escapes the envelope (INV-10). */
export function assertNoCredentialLeak(value: unknown, path = '$'): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoCredentialLeak(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (isCredentialShaped(k) && v != null && v !== '') {
        throw new Error(`INV-10 violation: credential-shaped field "${k}" at ${path} in MCP result`);
      }
      assertNoCredentialLeak(v, `${path}.${k}`);
    }
  }
}

export class McpServerFace {
  private readonly defaultLimit: number;
  private readonly maxLimit: number;

  constructor(
    private readonly backend: McpBackend,
    private readonly rateLimiter: McpRateLimiter,
    private readonly quota: McpQuota,
    opts: McpFaceOptions = {},
  ) {
    this.defaultLimit = opts.defaultLimit ?? 10;
    this.maxLimit = opts.maxLimit ?? 50;
  }

  /** tools/list — identical for every tenant; no connector identity leaks (§3.2 rule 1). */
  listTools(): readonly Omit<import('./toolSurface.js').McpToolDef, 'requiredScope'>[] {
    return listTools();
  }

  /**
   * The single request entrypoint. `requestId` is the JSON-RPC id, reused as the
   * quota dedupe key (§3.5): QuotaService does not dedupe at action level.
   */
  async call(
    binding: McpPrincipalBinding,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    requestId: string,
  ): Promise<McpResult<McpSearchHit[] | McpFetchResult | McpActResult>> {
    const tool = toolByName(toolName);
    if (!tool) {
      return { ok: false, error: { code: MCP_ERR.BAD_REQUEST, message: `unknown tool ${toolName}` } };
    }

    // authz — scope-gated per tool. Absence of scope is denial (§3.3).
    if (!binding.scopes.includes(tool.requiredScope)) {
      return { ok: false, error: { code: MCP_ERR.SCOPE_DENIED, message: 'scope denied' } };
    }

    // §3.3: the face NEVER accepts a tenantId argument — tenant is from the token.
    if ('tenantId' in args) {
      return { ok: false, error: { code: MCP_ERR.BAD_REQUEST, message: 'tenantId is not an accepted argument' } };
    }

    // rate limit → quota (cheap-first; both keyed to isolate a runaway client).
    const rl = await this.rateLimiter.tryConsume({
      tenantId: binding.tenantId, principalId: binding.principalId, clientId: binding.clientId,
    });
    if (rl.kind === 'hard') {
      return { ok: false, error: { code: MCP_ERR.RATE_LIMITED, message: 'rate limited', retryAfterMs: rl.retryAfterMs } };
    }
    const q = await this.quota.preflight({ tenantId: binding.tenantId, tool: toolName });
    if (q.kind === 'deny') {
      return { ok: false, error: { code: MCP_ERR.RATE_LIMITED, message: 'quota exhausted', retryAfterMs: q.resetAtMs } };
    }

    try {
      const value = await this.dispatch(binding, toolName, args);
      // INV-10 backstop: nothing credential-shaped leaves the face.
      assertNoCredentialLeak(value);
      await this.quota.record({ tenantId: binding.tenantId, tool: toolName, dedupeKey: requestId });
      return { ok: true, value };
    } catch (e) {
      // Only the deliberate not-found message crosses the face; any other
      // error's text is internal detail an external client must not see
      // (backend exception messages can name tables, hosts, or invariants).
      const message = e instanceof McpNotFoundError ? e.message : 'internal error';
      return { ok: false, error: { code: MCP_ERR.INTERNAL, message } };
    }
  }

  private async dispatch(
    binding: McpPrincipalBinding,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<McpSearchHit[] | McpFetchResult | McpActResult> {
    switch (toolName) {
      case 'oweibo.search': {
        const query = String(args['query'] ?? '');
        const source = typeof args['source'] === 'string' ? (args['source'] as string) : undefined;
        const rawLimit = typeof args['limit'] === 'number' ? (args['limit'] as number) : this.defaultLimit;
        const limit = Math.max(1, Math.min(this.maxLimit, rawLimit));
        const hits = await this.backend.search({ binding, query, source, limit });
        // §3.2 rule 5 — drop any hit missing provenance rather than return it uncited.
        return hits.filter((h) => h.citation && h.citation.knowledgeObjectId);
      }
      case 'oweibo.fetch': {
        const id = String(args['knowledgeObjectId'] ?? '');
        const r = await this.backend.fetch({ binding, knowledgeObjectId: id });
        if ('notFoundOrDenied' in r) {
          // §3.3 — a denied fetch and a nonexistent object return the SAME error.
          // Distinguishing them turns fetch into an existence oracle across ACL.
          throw new McpNotFoundError();
        }
        return r;
      }
      case 'oweibo.act': {
        const capabilityId = String(args['capabilityId'] ?? '');
        const actionArgs = (args['arguments'] ?? {}) as Readonly<Record<string, unknown>>;
        // The action class is the capability's, resolved inside the backend via
        // ConnectorActionService — the client's arguments cannot lower it (§3.2 rule 4).
        return this.backend.act({ binding, capabilityId, arguments: actionArgs });
      }
      default:
        throw new Error(`unhandled tool ${toolName}`);
    }
  }
}
