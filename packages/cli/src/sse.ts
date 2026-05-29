/**
 * sse.ts — Server-Sent Events streaming client for the oweibo CLI.
 */
import { loadConfig } from './client.js';
import { TaskEventRenderer } from './renderer/TaskEventRenderer.js';

export interface TaskEvent {
  type: string;
  taskId: string;
  stage?: string;
  message?: string;
  data?: unknown;
  timestamp?: string;
}

/** Stream task events from /tasks/:id/events until the stream closes or the callback returns false */
export async function streamEvents(
  taskId: string,
  onEvent: (event: TaskEvent) => void,
): Promise<void> {
  const cfg = loadConfig('OWEIBO_API_URL', 'http://localhost:3100/api/v1');
  const url = `${cfg.baseUrl}/tasks/${taskId}/events`;

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

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
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const raw = line.slice(6).trim();
              if (raw === '[DONE]') { resolve(); return; }
              try {
                const event = JSON.parse(raw) as TaskEvent;
                onEvent(event);
              } catch {
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
export function printEvent(event: TaskEvent, raw: boolean): void {
  const handled = TaskEventRenderer.render(event, raw);
  if (!handled && !raw && event.message) {
    const ts     = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
    const prefix = ts ? `[${ts}]` : '';
    const stage  = event.stage ? ` [${event.stage}]` : '';
    console.log(`${prefix}${stage} ${event.message}`);
  }
}
