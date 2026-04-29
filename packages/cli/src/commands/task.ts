/**
 * oweibo task — unified task management subcommands
 *
 * task submit <instruction>  — submit a task (streams events with --wait)
 * task list                  — list tasks for the current tenant
 * task status <taskId>       — show task status
 * task pause  <taskId>       — pause a running task
 * task cancel <taskId>       — cancel a running task
 * task clear                 — clear the pending task queue
 */
import { Command } from 'commander';
import { api } from '../client.js';
import { streamEvents, printEvent } from '../sse.js';
import { readFileSync, existsSync } from 'fs';

export function makeTaskCommand(): Command {
  const task = new Command('task').description('Task management');

  // task submit
  task
    .command('submit [instruction]')
    .description('Submit a task and optionally stream live events')
    .option('-f, --file <path>', 'Read instruction from a file')
    .option('-w, --wait',        'Wait for completion (streams events)', false)
    .option('--json',            'Output raw JSON', false)
    .action(async (instruction: string | undefined, opts: { file?: string; wait?: boolean; json?: boolean }) => {
      let text = instruction ?? '';
      if (opts.file) {
        if (!existsSync(opts.file)) {
          console.error(`File not found: ${opts.file}`);
          process.exit(1);
        }
        text = readFileSync(opts.file, 'utf-8').trim();
      }
      if (!text) { console.error('Provide an instruction or use --file'); process.exit(1); }

      try {
        const res = await api.post<{ taskId: string; status: string }>('/tasks', { instruction: text });
        if (opts.json) { console.log(JSON.stringify(res)); return; }
        console.log(`Task submitted: ${res.taskId}`);
        console.log(`Status: ${res.status}`);
        if (opts.wait) {
          console.log('Streaming events (Ctrl+C to detach)...\n');
          await streamEvents(res.taskId, event => {
            printEvent(event, opts.json ?? false);
            if (event.type === 'task-completed' || event.type === 'task-failed') {
              process.exit(event.type === 'task-completed' ? 0 : 1);
            }
          });
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  // task list
  task
    .command('list')
    .description('List tasks for the current tenant')
    .option('--status <status>', 'Filter by status (pending|running|completed|failed)')
    .option('--limit <n>',       'Max results', '20')
    .option('--json',            'Output raw JSON')
    .action(async (opts: { status?: string; limit?: string; json?: boolean }) => {
      const qs = new URLSearchParams();
      if (opts.status) qs.set('status', opts.status);
      if (opts.limit)  qs.set('limit',  opts.limit);
      const path = `/tasks${qs.toString() ? '?' + qs.toString() : ''}`;
      try {
        const result = await api.get<{ tasks: any[]; count: number }>(path);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        const tasks = result.tasks ?? [];
        if (tasks.length === 0) { console.log('No tasks'); return; }
        for (const t of tasks) {
          console.log(`  ${t.taskId ?? t.id}  status: ${t.status}  ${t.createdAt ?? ''}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  // task status
  task
    .command('status <taskId>')
    .description('Show task status and progress')
    .option('--json', 'Output raw JSON')
    .action(async (taskId: string, opts: { json?: boolean }) => {
      try {
        const result = await api.get<any>(`/tasks/${taskId}`);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(`Task:   ${taskId}`);
        console.log(`Status: ${result.status}`);
        if (result.progress) console.log(`Progress: ${JSON.stringify(result.progress)}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  // task pause
  task
    .command('pause <taskId>')
    .description('Pause a running task')
    .option('--json', 'Output raw JSON')
    .action(async (taskId: string, opts: { json?: boolean }) => {
      try {
        const result = await api.post(`/tasks/${taskId}/redirect`, { type: 'pause' });
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Task ${taskId} paused`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  // task cancel
  task
    .command('cancel <taskId>')
    .description('Cancel a running task')
    .option('--json', 'Output raw JSON')
    .action(async (taskId: string, opts: { json?: boolean }) => {
      try {
        const result = await api.post(`/tasks/${taskId}/redirect`, { type: 'cancel' });
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Task ${taskId} cancelled`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  // task clear
  task
    .command('clear')
    .description('Clear the pending task queue')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await api.post('/task/clear');
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log('Task queue cleared');
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  return task;
}
