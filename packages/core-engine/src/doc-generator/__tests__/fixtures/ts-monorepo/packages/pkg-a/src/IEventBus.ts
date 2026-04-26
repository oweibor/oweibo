import type { EventDoc } from './EventDoc.js';

/** Contract for the event bus used by pkg-a. */
export interface IEventBus {
  publish(event: EventDoc): Promise<void>;
  subscribe(type: string, handler: (event: EventDoc) => void): () => void;
}
