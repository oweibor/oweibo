/**
 * Custom connector manifests — the pure validation contract.
 *
 * A custom connector is a tenant-authored manifest, not a code bundle: the
 * tenant declares identity, category, credential shape, action capabilities,
 * and (optionally) an MCP server plus the tools it is ALLOWED to expose.
 * Everything a first-party bundle proves through certification, a custom
 * manifest must instead be prevented from CLAIMING (INV-15: declare only
 * what certification can demonstrate):
 *
 *  - `custom.` id prefix — can never collide with or shadow a platform
 *    catalog id, and marks tenant provenance on every downstream row.
 *  - category from the closed ConnectorCategory enum (same set the SDK
 *    enforces for first-party bundles at compile time).
 *  - NO Glean-face support claims (changeFeed/content/acl/webhooks): those
 *    require certified ports a manifest cannot carry. A custom connector is
 *    an action/tool connector until platform certification says otherwise.
 *  - NO reserved action classes: `governance.*` capabilities are the
 *    platform's own control plane (ADR-006 §3.4's dual-control class lives
 *    there) — a tenant manifest must not be able to mint actions in it.
 *  - certificationTarget is pinned `experimental` — tiers are earned, not
 *    asserted.
 *  - declared MCP tools without an MCP server URL are meaningless and
 *    refused; WITH a URL they become the ADR-009 §3.6 authority set — the
 *    only tools the inbound gate will ever admit from that server.
 */
import type { ConnectorCategory } from '@oweibo/core-contracts';

export const CUSTOM_CONNECTOR_ID_PATTERN = /^custom\.[a-z0-9][a-z0-9_-]{1,80}$/;

export const CONNECTOR_CATEGORIES: readonly ConnectorCategory[] = [
  'communication', 'source_control', 'database', 'storage',
  'observability', 'payment', 'identity', 'custom',
];

/** Action-class prefixes a tenant manifest may never declare. */
export const RESERVED_ACTION_CLASS_PREFIXES = ['governance.'] as const;

export interface CustomCapabilityInput {
  readonly capabilityId: string;
  readonly summary: string;
  readonly actionClass: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface CustomConnectorManifestInput {
  readonly connectorId: string;
  readonly displayName: string;
  readonly category: string;
  readonly description: string;
  readonly catalogVersion: string;
  readonly credentialSchema: unknown;
  readonly capabilities?: readonly CustomCapabilityInput[];
  readonly mcpServerUrl?: string;
  readonly declaredTools?: readonly string[];
}

export interface ManifestViolation {
  readonly field: string;
  readonly message: string;
}

/** Validate a custom manifest. Empty array = registrable. */
export function validateCustomManifest(m: CustomConnectorManifestInput): ManifestViolation[] {
  const v: ManifestViolation[] = [];

  if (!CUSTOM_CONNECTOR_ID_PATTERN.test(m.connectorId)) {
    v.push({
      field: 'connectorId',
      message: `must match ${CUSTOM_CONNECTOR_ID_PATTERN} — the 'custom.' prefix keeps tenant manifests from shadowing platform catalog ids`,
    });
  }
  if (!m.displayName || m.displayName.trim().length === 0 || m.displayName.length > 120) {
    v.push({ field: 'displayName', message: 'required, at most 120 characters' });
  }
  if (!CONNECTOR_CATEGORIES.includes(m.category as ConnectorCategory)) {
    v.push({ field: 'category', message: `must be one of the closed set: ${CONNECTOR_CATEGORIES.join(', ')}` });
  }
  if (!m.description || m.description.trim().length === 0 || m.description.length > 2000) {
    v.push({ field: 'description', message: 'required, at most 2000 characters' });
  }
  if (!m.catalogVersion || m.catalogVersion.length > 40) {
    v.push({ field: 'catalogVersion', message: 'required, at most 40 characters' });
  }

  // Credential schema: a JSON-Schema-shaped object. The install flow never
  // stores credentials here (vault_path only, INV-10) — the schema exists so
  // the admin UI can render the credential form.
  if (
    m.credentialSchema === null
    || typeof m.credentialSchema !== 'object'
    || Array.isArray(m.credentialSchema)
    || typeof (m.credentialSchema as Record<string, unknown>)['type'] !== 'string'
  ) {
    v.push({ field: 'credentialSchema', message: 'must be a JSON Schema object with a "type"' });
  }

  const caps = m.capabilities ?? [];
  if (caps.length > 64) {
    v.push({ field: 'capabilities', message: 'at most 64 capabilities per manifest' });
  }
  const seenCapIds = new Set<string>();
  caps.forEach((c, i) => {
    if (!c.capabilityId || !/^[a-z0-9][a-z0-9_.-]{0,80}$/.test(c.capabilityId)) {
      v.push({ field: `capabilities[${i}].capabilityId`, message: 'required, lowercase identifier' });
    } else if (seenCapIds.has(c.capabilityId)) {
      v.push({ field: `capabilities[${i}].capabilityId`, message: `duplicate capabilityId ${c.capabilityId}` });
    } else {
      seenCapIds.add(c.capabilityId);
    }
    if (!c.summary || c.summary.length > 300) {
      v.push({ field: `capabilities[${i}].summary`, message: 'required, at most 300 characters' });
    }
    // A capability WITHOUT an action class cannot be gated by the trust
    // ladder — that is an ungovernable action, refused outright (INV-11:
    // the class is the gate input, so it must exist and be well-formed).
    if (!c.actionClass || !/^[a-z0-9][a-z0-9_.-]{1,80}$/.test(c.actionClass)) {
      v.push({ field: `capabilities[${i}].actionClass`, message: 'required — an action without a class cannot be gated' });
    } else {
      for (const reserved of RESERVED_ACTION_CLASS_PREFIXES) {
        if (c.actionClass.startsWith(reserved)) {
          v.push({
            field: `capabilities[${i}].actionClass`,
            message: `${reserved}* classes are the platform control plane — not declarable by a tenant manifest`,
          });
        }
      }
    }
  });

  // Glean-face claims are structurally absent from the input type; the two
  // MCP fields are validated as a pair.
  const tools = m.declaredTools ?? [];
  if (m.mcpServerUrl !== undefined) {
    let ok = false;
    try {
      const u = new URL(m.mcpServerUrl);
      ok = u.protocol === 'https:' || u.protocol === 'http:';
    } catch { /* invalid */ }
    if (!ok) v.push({ field: 'mcpServerUrl', message: 'must be a valid http(s) URL' });
    if (tools.length === 0) {
      v.push({
        field: 'declaredTools',
        message: 'an MCP server without declared tools exposes nothing — the manifest is the authority set (ADR-009 §3.6)',
      });
    }
  } else if (tools.length > 0) {
    v.push({ field: 'declaredTools', message: 'declared tools require an mcpServerUrl' });
  }
  if (tools.length > 128) {
    v.push({ field: 'declaredTools', message: 'at most 128 declared tools' });
  }
  const seenTools = new Set<string>();
  tools.forEach((t, i) => {
    if (!t || t.length > 120) {
      v.push({ field: `declaredTools[${i}]`, message: 'tool names must be nonempty, at most 120 characters' });
    } else if (seenTools.has(t)) {
      v.push({ field: `declaredTools[${i}]`, message: `duplicate tool ${t}` });
    } else {
      seenTools.add(t);
    }
  });

  return v;
}

export class InvalidCustomManifestError extends Error {
  public readonly code = 'invalid_custom_manifest' as const;
  constructor(public readonly violations: readonly ManifestViolation[]) {
    super(`invalid_custom_manifest: ${violations.length} violation(s)`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
