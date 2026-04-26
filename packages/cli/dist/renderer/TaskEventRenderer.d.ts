/**
 * TaskEventRenderer — formats TaskEvents for the oweibo CLI terminal.
 *
 * Each static method accepts a raw TaskEvent and a timestamp prefix string,
 * and writes formatted output to stdout/stderr. This module is the single
 * place to add new event render cases so sse.ts stays thin.
 */
import type { TaskEvent } from '../sse.js';
export declare class TaskEventRenderer {
    /**
     * Render a single TaskEvent to the terminal. Returns true if the event was
     * handled (has a specific case), false if it fell through to the generic handler.
     */
    static render(event: TaskEvent, raw: boolean): boolean;
}
//# sourceMappingURL=TaskEventRenderer.d.ts.map