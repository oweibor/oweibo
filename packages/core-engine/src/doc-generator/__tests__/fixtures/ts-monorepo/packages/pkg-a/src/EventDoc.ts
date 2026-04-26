/**
 * EventDoc represents a single domain event record.
 * Intentionally shares the name `EventDoc` with pkg-b to test cross-ref disambiguation.
 */
export interface EventDoc {
  readonly id:        string;
  readonly type:      string;
  readonly payload:   unknown;
  readonly timestamp: Date;
}

/** Build a minimal EventDoc with defaults. */
export function buildEvent(type: string, payload: unknown): EventDoc {
  return { id: crypto.randomUUID(), type, payload, timestamp: new Date() };
}
