/**
 * ConnectorContext — the one object every capability invoke and every
 * port method receives. Extracted from declareConnector.ts at K.1 so the
 * port modules can import it without a cycle; declareConnector re-exports
 * it, so existing `import { ConnectorContext } from './declareConnector.js'`
 * (and the package barrel) are unchanged.
 *
 * K.1 additive extension (ADR-012 §3.2): `now`, `checkpoints` (read
 * access), and `quota` (view). Growing this context is additive; growing
 * port parameter lists is a review finding.
 *
 * The context will NEVER carry (ADR-012 §3.2, normative):
 *   - an event publisher — connectors do not emit platform events; the
 *     runtime does (INV-16)
 *   - a raw vault handle — credential custody stays behind the resolver
 *     (INV-10); `credentials` is the resolved, already-decrypted payload
 *   - a scheduler handle — scheduling is platform runtime (ADR-013)
 */

export interface ConnectorContext {
  readonly tenantId: string;
  /** Tenant connector instance id (for credential lookup). */
  readonly tenantConnectorId: string;
  /** Resolved credentials — already secrets-manager-decrypted. */
  readonly credentials: Readonly<Record<string, unknown>>;
  /** Free-form trace hook authors can use for observability. */
  readonly trace?: (event: string, attrs?: Record<string, unknown>) => void;

  // ── K.1 additive extension ─────────────────────────────────────────────

  /** Injected clock; adapters use this instead of Date.now() so replays
   *  and certification runs are deterministic. Optional for back-compat —
   *  fall back to `new Date()` when absent. */
  readonly now?: () => Date;
  /** Read-only view of this instance's persisted checkpoints (ADR-013).
   *  Writes are the runtime's job — adapters never persist progress. */
  readonly checkpoints?: {
    get(portId: string): Promise<string | null>;
  };
  /** Read-only quota view so an adapter can size batches politely.
   *  Enforcement is the runtime's job (quota-before-lease, ADR-013 §3.3). */
  readonly quota?: {
    remaining(kind: string): Promise<number | null>;
  };
}
