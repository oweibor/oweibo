export interface TaskEvent {
    type: string;
    taskId: string;
    stage?: string;
    message?: string;
    data?: unknown;
    timestamp?: string;
}
/** Stream task events from /tasks/:id/events until the stream closes or the callback returns false */
export declare function streamEvents(taskId: string, onEvent: (event: TaskEvent) => void): Promise<void>;
/** Format and print a task event to stdout. Delegates to TaskEventRenderer. */
export declare function printEvent(event: TaskEvent, raw: boolean): void;
//# sourceMappingURL=sse.d.ts.map