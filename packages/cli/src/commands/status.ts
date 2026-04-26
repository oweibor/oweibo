/**
 * oweibo status — show the current status of a task.
 *
 * Usage:
 *   oweibo status <taskId>
 *   oweibo status <taskId> --follow
 */
import { Command } from 'commander';
import { api } from '../client.js';
import { streamEvents, printEvent } from '../sse.js';

interface TaskStatus {
  taskId: string;
  status: string;
  stage?: string;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface StatusOptions {
  follow?: boolean;
  json?: boolean;
}

export function makeStatusCommand(): Command {
  return new Command('status')
    .description('Show the status of a running or completed task')
    .argument('<taskId>', 'Task ID to query')
    .option('-f, --follow', 'Follow event stream until task completes', false)
    .option('--json', 'Output raw JSON', false)
    .action(async (taskId: string, opts: StatusOptions) => {
      try {
        const status = await api.get<TaskStatus>(`/tasks/${taskId}`);

        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(`Task:     ${status.taskId}`);
          console.log(`Status:   ${status.status}`);
          if (status.stage)       console.log(`Stage:    ${status.stage}`);
          if (status.progress !== undefined) console.log(`Progress: ${status.progress}%`);
          if (status.startedAt)   console.log(`Started:  ${new Date(status.startedAt).toLocaleString()}`);
          if (status.completedAt) console.log(`Finished: ${new Date(status.completedAt).toLocaleString()}`);
          if (status.error)       console.error(`Error:    ${status.error}`);
        }

        if (opts.follow && !['completed', 'failed', 'cancelled'].includes(status.status)) {
          console.log('\nFollowing events...\n');
          await streamEvents(taskId, (event) => {
            printEvent(event, opts.json ?? false);
            if (event.type === 'task-completed' || event.type === 'task-failed') {
              process.exit(event.type === 'task-completed' ? 0 : 1);
            }
          });
        }
      } catch (err) {
        console.error(`Failed to get status for ${taskId}:`, (err as Error).message);
        process.exit(1);
      }
    });
}
