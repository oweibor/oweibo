/**
 * ADR-011 contract predicates — the content-trust / injection boundary, as
 * pure functions. Connector-derived content is DATA never instructions;
 * action gating is content-INDEPENDENT (the class comes from the certified
 * capability declaration, not from retrieved content); content inspectors are
 * UPGRADE-ONLY (they can only make the gate stricter); injection-suspect
 * content is quarantined (excluded from context).
 *
 * These ship green at ADR-011 ratification. K.7's ConnectorActionService
 * wraps the shipped ActionTrustLadder using `gateActionClass` as the
 * content-independent gate input; the K.7 battery proves an injected payload
 * gets the SAME gate mode as a benign one.
 */

/** The trust-mode lattice (mirrors ActionTrustLadder.TrustMode; ordered least→most restrictive). */
export type TrustMode = 'execute' | 'dry_run' | 'shadow' | 'require_approval' | 'forbidden';

export const MODE_LATTICE: readonly TrustMode[] = [
  'execute', 'dry_run', 'shadow', 'require_approval', 'forbidden',
];

function modeRank(m: TrustMode): number {
  return MODE_LATTICE.indexOf(m);
}

// ── §3.1 content is data ─────────────────────────────────────────────────
export type ContentOrigin = 'indexed_chunk' | 'live_mcp_result' | 'graph_context';
export type TrustLabel = 'data';

/**
 * Every connector-derived origin is DATA (§3.1). There is NO origin that
 * yields 'instruction' — retrieved text that reads like a command is data
 * describing a request, never an instruction the runtime obeys (INV-11).
 */
export function contentTrustLabel(_origin: ContentOrigin): TrustLabel {
  return 'data';
}

// ── §3.2 content-independent gating ──────────────────────────────────────
/** The minimal capability shape the gate reads — its DECLARED, certified class. */
export interface GatedCapability {
  readonly capabilityId: string;
  readonly actionClass: string;
}

/**
 * The gate's action_class comes ONLY from the capability declaration
 * (ADR-012, certified) — never from the payload's content, retrieved
 * documents, or tool results (§3.2, INV-11). Pure function of the
 * capability: injected content cannot change it, because it is not an input.
 */
export function gateActionClass(capability: GatedCapability): string {
  return capability.actionClass;
}

// ── §3.3 upgrade-only inspectors ─────────────────────────────────────────
export type InspectorVerdict = 'allow' | 'upgrade_to_approval' | 'forbid';

/**
 * Combine an inspector verdict with the base gate mode along the lattice
 * (§3.3). The result is NEVER below `baseMode` — `allow` leaves it,
 * `upgrade_to_approval` raises to at least `require_approval`, `forbid`
 * raises to `forbidden`. An inspector can only TIGHTEN the gate; adversarial
 * content, even when scanned, cannot move require_approval → execute.
 */
export function combineTrustVerdict(baseMode: TrustMode, verdict: InspectorVerdict): TrustMode {
  const raised: TrustMode =
    verdict === 'forbid' ? 'forbidden'
    : verdict === 'upgrade_to_approval' ? 'require_approval'
    : baseMode;
  // Monotonic: never return below the base.
  return modeRank(raised) >= modeRank(baseMode) ? raised : baseMode;
}

// ── §3.4 quarantine ──────────────────────────────────────────────────────
export type QuarantineDecision = 'admit' | 'exclude_from_context';

/**
 * Injection-suspect content is quarantined — EXCLUDED from the agent's data
 * channel (§3.4), never merely deprioritized. Exclusion is the default for
 * flagged content; a false positive costs recall, a false negative is caught
 * by content-independent gating (§3.2).
 */
export function quarantineDecision(injectionSuspect: boolean): QuarantineDecision {
  return injectionSuspect ? 'exclude_from_context' : 'admit';
}
