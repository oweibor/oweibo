import type { IEventBus } from '@fixture/pkg-a';

/**
 * EventDoc in pkg-b — same name as pkg-a's EventDoc (intentional collision for cross-ref tests).
 * This one represents a processed/enriched version of the raw event.
 */
export interface EventDoc {
  readonly rawId:      string;
  readonly processedAt: Date;
  readonly enriched:   Record<string, unknown>;
}

/**
 * EventProcessor consumes raw events from pkg-a's IEventBus and transforms them
 * into enriched EventDoc records for downstream analytics.
 */
export class EventProcessor {
  private readonly handlers = new Map<string, (doc: EventDoc) => void>();

  constructor(private readonly bus: IEventBus) {}

  /** Register a handler for a specific event type. */
  on(type: string, handler: (doc: EventDoc) => void): this {
    this.handlers.set(type, handler);
    return this;
  }

  /** Start listening on the bus. Returns a teardown function. */
  start(): () => void {
    const unsubscribers: Array<() => void> = [];
    for (const [type, handler] of this.handlers) {
      const unsub = this.bus.subscribe(type, (raw) => {
        const enriched: EventDoc = {
          rawId:       raw.id,
          processedAt: new Date(),
          enriched:    { type: raw.type, payload: raw.payload },
        };
        handler(enriched);
      });
      unsubscribers.push(unsub);
    }
    return () => unsubscribers.forEach((u) => u());
  }
}
