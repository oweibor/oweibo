// packages/core-engine/src/agentic/UnifiedObservationStream.ts
import { EventEmitter } from 'eventemitter3';
import { randomUUID } from 'crypto';

export type ObservationSource = 'browser' | 'shell' | 'filesystem' | 'api' | 'vlm' | 'pipeline';

export interface Observation<T = unknown> {
  id: string;
  timestamp: number;
  source: ObservationSource;
  type: string;
  data: T;
  correlationId?: string;
}

export class UnifiedObservationStream extends EventEmitter {
  private readonly buffer: Observation[] = [];
  private readonly MAX_BUFFER = 1000;

  add<T>(source: ObservationSource, type: string, data: T, correlationId?: string): Observation<T> {
    const obs: Observation<T> = {
      id: randomUUID(),
      timestamp: Date.now(),
      source,
      type,
      data,
      correlationId,
    };
    this.buffer.push(obs);
    if (this.buffer.length > this.MAX_BUFFER) this.buffer.shift();
    this.emit('observation', obs);
    return obs;
  }

  recent(n: number, filter?: { source?: ObservationSource; type?: string }): Observation[] {
    let obs = this.buffer;
    if (filter?.source) obs = obs.filter(o => o.source === filter.source);
    if (filter?.type)   obs = obs.filter(o => o.type === filter.type);
    return obs.slice(-n);
  }

  buildContextWindow(maxTokens: number): string {
    const lines: string[] = [];
    let tokenEstimate = 0;
    for (const obs of [...this.buffer].reverse()) {
      const line = `[${obs.source}/${obs.type}] ${JSON.stringify(obs.data)}`;
      const tokens = Math.ceil(line.length / 4);
      if (tokenEstimate + tokens > maxTokens) break;
      lines.unshift(line);
      tokenEstimate += tokens;
    }
    return lines.join('\n');
  }
}
