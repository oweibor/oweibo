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
import type { ConnectorContext } from './context.js';
import type { SupportMap } from './contract/manifestTruthfulness.js';
// Individual port modules, NOT the ports barrel: ports/action.ts imports
// CapabilityDeclaration from this file, so importing the barrel here would
// create a cycle. These five have no back-edge.
import type { ChangeFeedPort } from './ports/changeFeed.js';
import type { ContentPort } from './ports/content.js';
import type { AclPort } from './ports/acl.js';
import type { PrincipalsPort } from './ports/principals.js';
import type { ActivityPort } from './ports/activity.js';

// Moved to ./context.ts at K.1 (the port modules need it without a cycle);
// re-exported so pre-K.1 imports from this module keep compiling.
export type { ConnectorContext } from './context.js';

export type ConnectorSandboxMode = 'mock' | 'sandbox_endpoint' | 'pre_declared_replica';

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

/**
 * K.1 source-adapter bindings (ADR-012 §3.1 `ports:`). Mirrors
 * ports/index.ts `PortBindings`; declared structurally here to keep this
 * module cycle-free (see the import comment above).
 */
export interface ConnectorPortBindings {
  readonly changeFeed?: ChangeFeedPort;
  readonly content?: ContentPort;
  readonly acl?: AclPort;
  readonly principals?: PrincipalsPort;
  readonly activity?: ActivityPort;
}

/**
 * K.1 lifecycle hooks (ADR-012 §3.1). Hooks, not ports: the lifecycle
 * state machine they feed is ADR-004's, and everything else a "connector
 * lifecycle" needs — scheduling, retries, health evaluation, bootstrap,
 * token refresh — is platform runtime (P9), never author surface.
 */
export interface ValidateConnectionResult {
  readonly ok: boolean;
  /**
   * The *instance's* demonstrated capability subset — what this tenant's
   * scopes/license actually allow, which may be less than the manifest's
   * maximum claim (`supports{}` governs the catalog claim; this governs
   * the install — ADR-012 §3.3).
   */
  readonly effectiveSupports: SupportMap;
  readonly detail?: string;
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

  // ── K.1 (ADR-012 §3.1) additive manifest extension — all optional; ────
  // every D.4 connector keeps validating unchanged.

  /** SDK compatibility declaration; checked at load (N/N−1 window, §3.7). */
  readonly sdkVersion?: string;
  /** §10.4 tenant-install axis. NOT certificationTarget (two axes, §3.4). */
  readonly enablementTier?: 0 | 1 | 2;
  /** Liveness cadence handed to the scheduler (ADR-013). Default 300. */
  readonly heartbeatSeconds?: number;
  /** Region constraint (§18.3); carried, enforced by governance. */
  readonly dataResidency?: string;
  /**
   * The manifest's capability claim set (INV-15). Deliberately NOT
   * cross-checked against `ports` here: certification is the honesty
   * gate — a lying manifest must reach the harness and FAIL there
   * (the K.1 exit gate), not fail to construct.
   */
  readonly supports?: SupportMap;
  /** Source-adapter implementations (§3.2). */
  readonly ports?: ConnectorPortBindings;
  /** Field → freshness class. Carried; semantics are ADR-008's. */
  readonly freshnessClasses?: Readonly<Record<string, string>>;

  // Lifecycle hooks (§3.1) — the ONLY author-side lifecycle surface.

  /** Install-time check driving tenant_connectors.status pending → active. */
  validateConnection?(ctx: ConnectorContext): Promise<ValidateConnectionResult>;
  /** Present iff supports.webhooks — both or neither (webhook truthfulness). */
  registerWebhook?(ctx: ConnectorContext): Promise<void>;
  unregisterWebhook?(ctx: ConnectorContext): Promise<void>;
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

  // ── K.1 structural invariants. Deliberately NOT here: supports↔ports
  // consistency — that is certification's honesty gate (INV-15), and a
  // lying manifest must construct fine and then FAIL the harness.

  // Invariant 4: enablementTier, when declared, is 0|1|2 (§10.4 axis).
  if (spec.enablementTier !== undefined && ![0, 1, 2].includes(spec.enablementTier)) {
    throw new Error(
      `declareConnector(${spec.connectorId}): enablementTier must be 0, 1, or 2 — got ${String(spec.enablementTier)}`,
    );
  }
  // Invariant 5: heartbeatSeconds, when declared, is a positive integer.
  if (
    spec.heartbeatSeconds !== undefined &&
    (!Number.isInteger(spec.heartbeatSeconds) || spec.heartbeatSeconds <= 0)
  ) {
    throw new Error(
      `declareConnector(${spec.connectorId}): heartbeatSeconds must be a positive integer — got ${String(spec.heartbeatSeconds)}`,
    );
  }
  // Invariant 6: webhook hooks come as a pair (registration without a
  // teardown path leaks source-side subscriptions on uninstall).
  if (Boolean(spec.registerWebhook) !== Boolean(spec.unregisterWebhook)) {
    throw new Error(
      `declareConnector(${spec.connectorId}): registerWebhook and unregisterWebhook must both be declared or both be omitted`,
    );
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
      // K.1 additive manifest fields — emitted only when declared, so
      // pre-K.1 .connector.json snapshots stay byte-identical.
      ...(spec.sdkVersion !== undefined ? { sdkVersion: spec.sdkVersion } : {}),
      ...(spec.enablementTier !== undefined ? { enablementTier: spec.enablementTier } : {}),
      ...(spec.heartbeatSeconds !== undefined ? { heartbeatSeconds: spec.heartbeatSeconds } : {}),
      ...(spec.dataResidency !== undefined ? { dataResidency: spec.dataResidency } : {}),
      ...(spec.supports !== undefined
        ? { supports: Object.fromEntries(Object.entries(spec.supports).filter(([, v]) => typeof v === 'boolean')) }
        : {}),
      ...(spec.freshnessClasses !== undefined ? { freshnessClasses: spec.freshnessClasses } : {}),
    },
  };
}
