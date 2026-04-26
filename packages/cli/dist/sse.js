"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamEvents = streamEvents;
exports.printEvent = printEvent;
/**
 * sse.ts — Server-Sent Events streaming client for the oweibo CLI.
 */
const client_js_1 = require("./client.js");
const TaskEventRenderer_js_1 = require("./renderer/TaskEventRenderer.js");
/** Stream task events from /tasks/:id/events until the stream closes or the callback returns false */
async function streamEvents(taskId, onEvent) {
    const cfg = (0, client_js_1.loadConfig)();
    const url = `${cfg.baseUrl}/tasks/${taskId}/events`;
    return new Promise((resolve, reject) => {
        const headers = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
        };
        if (cfg.apiKey)
            headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        // Use native fetch with ReadableStream for SSE
        fetch(url, { headers, signal: AbortSignal.timeout(300_000) })
            .then(async (res) => {
            if (!res.ok || !res.body) {
                reject(new Error(`SSE connection failed: ${res.status}`));
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const raw = line.slice(6).trim();
                        if (raw === '[DONE]') {
                            resolve();
                            return;
                        }
                        try {
                            const event = JSON.parse(raw);
                            onEvent(event);
                        }
                        catch {
                            // Non-JSON SSE line — skip
                        }
                    }
                }
            }
            resolve();
        })
            .catch(reject);
    });
}
/** Format and print a task event to stdout. Delegates to TaskEventRenderer. */
function printEvent(event, raw) {
    const handled = TaskEventRenderer_js_1.TaskEventRenderer.render(event, raw);
    if (!handled && !raw && event.message) {
        const ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
        const prefix = ts ? `[${ts}]` : '';
        const stage = event.stage ? ` [${event.stage}]` : '';
        console.log(`${prefix}${stage} ${event.message}`);
    }
}
//# sourceMappingURL=sse.js.map