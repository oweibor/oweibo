/**
 * ADR-009 §3.6 — INBOUND gating: manifest is authority, MCP is evidence.
 *
 * An external MCP server's advertised tool list is capability EVIDENCE, never
 * capability AUTHORITY. A tool the server advertises that the connector's
 * manifest does not declare MUST NOT be callable — it is dropped at discovery
 * and flagged as a manifest-truthfulness divergence (ADR-012 INV-15).
 *
 * This wraps the shipped MCPClientRegistry's discovery, which is otherwise an
 * unfiltered passthrough of whatever the server returns.
 */

export interface DiscoveredTool {
  readonly name: string;
}

export interface ManifestGateResult {
  /** Tools the manifest declares AND the server advertises — the callable set. */
  readonly admitted: readonly string[];
  /** Advertised but undeclared — dropped, and each a divergence to flag. */
  readonly divergences: readonly string[];
}

/**
 * Intersect the server's advertised tools with the connector manifest's declared
 * capabilities. Only the intersection is callable; the server-only remainder is
 * a divergence (INV-15) — certification should have caught it, so surfacing it
 * at runtime is a signal, not an expected path.
 */
export function gateInboundTools(
  advertised: readonly DiscoveredTool[],
  declaredCapabilities: readonly string[],
): ManifestGateResult {
  const declared = new Set(declaredCapabilities);
  const admitted: string[] = [];
  const divergences: string[] = [];
  for (const t of advertised) {
    if (declared.has(t.name)) admitted.push(t.name);
    else divergences.push(t.name);
  }
  return { admitted, divergences };
}
