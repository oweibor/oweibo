import { EventEmitter } from 'eventemitter3';
export type ObservationSource = 'browser' | 'shell' | 'filesystem' | 'api' | 'vlm' | 'pipeline';
export interface Observation<T = unknown> {
    id: string;
    timestamp: number;
    source: ObservationSource;
    type: string;
    data: T;
    correlationId?: string;
}
export declare class UnifiedObservationStream extends EventEmitter {
    private readonly buffer;
    private readonly MAX_BUFFER;
    add<T>(source: ObservationSource, type: string, data: T, correlationId?: string): Observation<T>;
    recent(n: number, filter?: {
        source?: ObservationSource;
        type?: string;
    }): Observation[];
    buildContextWindow(maxTokens: number): string;
}
//# sourceMappingURL=UnifiedObservationStream.d.ts.map