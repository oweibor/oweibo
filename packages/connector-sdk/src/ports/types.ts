/**
 * K.1 (ADR-012 §3.2) — shared port types: the cursor-page iteration
 * contract, the §11.7 failure taxonomy, and the health-probe shape every
 * port exposes.
 *
 * The iteration contract is normative: all list-style methods are
 * cursor-paged pull — bounded batches with an opaque `nextCursor` — NEVER
 * streams or unbounded arrays. Resumability comes from checkpoints
 * (ADR-013) and a 100M-record crawl is a partitioned job family; both work
 * only if progress is a persistable cursor. `paginate()` in the convention
 * layer offers AsyncIterable sugar over pages; the *contract* is the page.
 */

/**
 * Opaque resume token. The platform persists it verbatim as a checkpoint
 * (ADR-013) and hands it back on the next call; adapters must accept a
 * cursor they previously emitted, including across process restarts.
 */
export type Cursor = string;

/** One bounded batch of a cursor-paged listing. */
export interface Page<T> {
  readonly items: readonly T[];
  /**
   * Resume token for the next batch. Two distinct meanings:
   *   - non-null with items:   more data — call again with this cursor.
   *   - non-null, items empty: caught up, but the feed is resumable —
   *     persist the cursor and poll later (this is what demonstrates
   *     `deltaSync`: the tail of the feed is still a valid resume point).
   *   - null: the listing is exhausted and NOT resumable (snapshot-only).
   */
  readonly nextCursor: Cursor | null;
}

/**
 * §11.7 failure taxonomy rows a port maps its errors onto. Normative:
 * the lifecycle state machine (ADR-004) and planner fallback (ADR-001)
 * react to the class, never to source-specific error shapes.
 *
 *   transient      — retry with backoff (5xx, rate limit, timeout)
 *   permanent      — do not retry; needs human/credential intervention
 *                    (revoked grant, 401/403, deleted source)
 *   partial        — this capability is down but siblings are healthy
 *                    (ACL API down while content API is up)
 *   corrupt_poison — the payload itself is bad; quarantine the item,
 *                    do not retry the same input
 */
export type PortFailureClass = 'transient' | 'permanent' | 'partial' | 'corrupt_poison';

/**
 * The error type port methods MUST throw. Anything else escaping a port
 * is treated as `transient` by the runtime (safe default: retried with
 * budget, never silently dropped) and surfaced as a mapping gap.
 */
export class PortError extends Error {
  readonly failureClass: PortFailureClass;
  /** Optional source-native detail for forensics; never parsed by the platform. */
  readonly detail?: unknown;

  constructor(failureClass: PortFailureClass, message: string, detail?: unknown) {
    super(message);
    this.name = 'PortError';
    this.failureClass = failureClass;
    if (detail !== undefined) this.detail = detail;
  }

  static transient(message: string, detail?: unknown): PortError {
    return new PortError('transient', message, detail);
  }
  static permanent(message: string, detail?: unknown): PortError {
    return new PortError('permanent', message, detail);
  }
  static partial(message: string, detail?: unknown): PortError {
    return new PortError('partial', message, detail);
  }
  static corruptPoison(message: string, detail?: unknown): PortError {
    return new PortError('corrupt_poison', message, detail);
  }
}

/** Result of a per-port health probe. */
export interface PortProbeResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * Every port carries an apiVersion and a health probe. The probe is
 * called independently per port by the platform runtime — this is what
 * makes the §11.7 *partial* row ("ACL API healthy, content API down")
 * detectable per capability rather than per connector. Compatibility for
 * `apiVersion` follows §10.3 change-classes within the N/N−1 window.
 */
export interface PortBase<Ctx> {
  readonly apiVersion: 'v1';
  probe(ctx: Ctx): Promise<PortProbeResult>;
}
