/**
 * D.4 (domain-depth): declareConnector — author-facing builder for a
 * connector bundle.
 *
 * Authors write:
 *
 *     export const slackConnector = declareConnector({
 *       connectorId: 'slack',
 *       displayName: 'Slack',
 *       category: 'communication',
 *       description: '...',
 *       catalogVersion: '1.0.0',
 *       credentialSchema: { type: 'object', properties: { ... } },
 *       capabilities: [{
 *         capabilityId: 'send-message',
 *         summary: 'Send a message to a channel',
 *         actionClass: 'comm.external_message',
 *         inputSchema: { ... },
 *         outputSchema: { ... },
 *         invoke: async (input, ctx) => { ... },
 *       }],
 *       certificationTarget: 'verified',
 *       certifiedFor: ['devops'],
 *     });
 *
 * The bundle is a *runtime* object: the catalog metadata that ships in
 * `.connector.json` (the static surface the registry loads) PLUS the
 * runtime hooks (`invoke`, `sandboxAssertion`, declared inspectors and
 * verifiers) that the certification harness needs to exercise.
 *
 * `declareConnector()` enforces a few invariants that are easy to get
 * wrong by hand:
 *   1. capabilityIds are unique within the bundle
 *   2. actionClass strings are non-empty
 *   3. tiers >= 'community' require every capability to declare either a
 *      sandbox or to be explicitly marked `sandbox: { mode: 'mock' }`
 *
 * The 1.0 contract is intentionally minimal — we ship what the
 * certification harness exercises today. Authors needing more (per-
 * capability rate limits, custom rollback adapters with their own
 * action classes, etc.) compose with the seams already exposed by
 * ttv-action-safety-v2.
 */
import type {
  CertificationTier,
  ConnectorCatalogEntry,
  ConnectorCategory,
} from '@oweibo/core-contracts';

export type ConnectorSandboxMode = 'mock' | 'sandbox_endpoint' | 'pre_declared_replica';

export interface ConnectorContext {
  readonly tenantId: string;
  /** Tenant connector instance id (for credential lookup). */
  readonly tenantConnectorId: string;
  /** Resolved credentials — already secrets-manager-decrypted. */
  readonly credentials: Readonly<Record<string, unknown>>;
  /** Free-form trace hook authors can use for observability. */
  readonly trace?: (event: string, attrs?: Record<string, unknown>) => void;
}

export interface CapabilityResult {
  readonly status: 'ok' | 'failed';
  readonly output?: unknown;
  readonly message?: string;
  readonly details?: unknown;
}

export interface CapabilitySandbox {
  readonly mode: ConnectorSandboxMode;
  readonly config?: unknown;
  /**
   * Optional assertion the test harness runs after a sandboxed
   * invocation to validate behaviour (e.g., "the slack mock recorded a
   * postMessage call for the given channel").
   */
  sandboxAssertion?(input: unknown, output: unknown): Promise<void>;
}

export type ContentInspectorRunner = (input: {
  readonly payload: unknown;
}) => Promise<{
  readonly verdict: 'allow' | 'upgrade_to_approval' | 'forbid';
  readonly reason?: string;
}>;

export interface ContentInspectorDeclaration {
  readonly name: string;
  readonly inspect: ContentInspectorRunner;
}

export type VerifierRunner = (input: {
  readonly output: unknown;
}) => Promise<{
  readonly verdict: 'pass' | 'drift_low' | 'drift_high';
  readonly details?: unknown;
}>;

export interface VerifierDeclaration {
  readonly name: string;
  readonly verify: VerifierRunner;
}

export type RollbackAdapterRunner = (input: {
  readonly capabilityInput: unknown;
  readonly capabilityOutput: unknown;
}) => Promise<{ readonly status: 'ok' | 'failed'; readonly message?: string }>;

export interface RollbackAdapterDeclaration {
  readonly name: string;
  readonly rollback: RollbackAdapterRunner;
}

export interface CapabilityDeclaration {
  readonly capabilityId: string;
  readonly summary: string;
  readonly actionClass: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  /** Function that performs the actual capability. */
  invoke(input: unknown, ctx: ConnectorContext): Promise<CapabilityResult>;
  readonly sandbox?: CapabilitySandbox;
  readonly inspectors?: readonly ContentInspectorDeclaration[];
  readonly verifiers?: readonly VerifierDeclaration[];
  readonly rollback?: RollbackAdapterDeclaration;
}

export interface DeclareConnectorSpec {
  readonly connectorId: string;
  readonly displayName: string;
  readonly category: ConnectorCategory;
  readonly description: string;
  readonly catalogVersion: string;
  readonly credentialSchema: unknown;
  readonly capabilities: readonly CapabilityDeclaration[];
  readonly recommendedFor?: readonly string[];
  readonly certificationTarget: CertificationTier;
  readonly certifiedFor?: readonly string[];
}

export interface ConnectorBundle {
  readonly spec: DeclareConnectorSpec;
  /** The shape the static `.connector.json` registry consumes. */
  readonly catalogEntry: ConnectorCatalogEntry;
}

export function declareConnector(spec: DeclareConnectorSpec): ConnectorBundle {
  // Invariant 1: capabilityIds unique.
  const seen = new Set<string>();
  for (const c of spec.capabilities) {
    if (seen.has(c.capabilityId)) {
      throw new Error(
        `declareConnector(${spec.connectorId}): duplicate capabilityId ${JSON.stringify(c.capabilityId)}`,
      );
    }
    seen.add(c.capabilityId);
  }
  // Invariant 2: actionClass non-empty.
  for (const c of spec.capabilities) {
    if (typeof c.actionClass !== 'string' || c.actionClass.length === 0) {
      throw new Error(
        `declareConnector(${spec.connectorId}): capability ${c.capabilityId} missing actionClass`,
      );
    }
  }
  // Invariant 3: tiers >= 'community' require sandbox declarations.
  const tierOrder = { experimental: 0, community: 1, verified: 2, enterprise: 3 } as const;
  if (tierOrder[spec.certificationTarget] >= tierOrder.community) {
    for (const c of spec.capabilities) {
      if (!c.sandbox) {
        throw new Error(
          `declareConnector(${spec.connectorId}): tier ${spec.certificationTarget} requires capability ${c.capabilityId} to declare a sandbox`,
        );
      }
    }
  }

  return {
    spec,
    catalogEntry: {
      connectorId: spec.connectorId,
      displayName: spec.displayName,
      category: spec.category,
      description: spec.description,
      catalogVersion: spec.catalogVersion,
      credentialSchema: spec.credentialSchema,
      capabilities: spec.capabilities.map((c) => ({
        capabilityId: c.capabilityId,
        summary: c.summary,
        actionClass: c.actionClass,
        inputSchema: c.inputSchema,
        outputSchema: c.outputSchema,
        ...(c.sandbox
          ? {
              shadowTarget: {
                mode: c.sandbox.mode,
                ...(c.sandbox.config !== undefined ? { config: c.sandbox.config } : {}),
              },
            }
          : {}),
      })),
      recommendedFor: spec.recommendedFor ?? [],
      certification: spec.certificationTarget,
      certifiedFor: spec.certifiedFor ?? [],
    },
  };
}
