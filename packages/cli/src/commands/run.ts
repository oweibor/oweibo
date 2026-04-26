/**
 * oweibo run — submit a task and stream live events.
 *
 * Usage:
 *   oweibo run "build me a Next.js app with auth and Postgres"
 *   oweibo run --file task.txt --tenant acme-corp
 *   oweibo run "fix the login bug" --mode general-coding --wait
 */
import { Command } from 'commander';
import { api } from '../client.js';
import { streamEvents, printEvent } from '../sse.js';
import { readFileSync, existsSync } from 'fs';

interface RunOptions {
  file?: string;
  wait?: boolean;
  json?: boolean;
}

interface TaskSubmitResponse {
  taskId: string;
  status: string;
}

export function makeRunCommand(): Command {
  return new Command('run')
    .description('Submit a task to oweibo and stream live progress events')
    .argument('[instruction]', 'Task instruction (or use --file)')
    .option('-f, --file <path>', 'Read task instruction from a file')
    .option('-w, --wait', 'Wait for task completion before exiting (streams events)', false)
    .option('--json', 'Output raw JSON instead of formatted output', false)
    .action(async (instruction: string | undefined, opts: RunOptions) => {
      let taskInstruction = instruction ?? '';

      if (opts.file) {
        if (!existsSync(opts.file)) {
          console.error(`Error: File not found: ${opts.file}`);
          process.exit(1);
        }
        taskInstruction = readFileSync(opts.file, 'utf-8').trim();
      }

      if (!taskInstruction) {
        console.error('Error: Provide an instruction or use --file');
        process.exit(1);
      }

      try {
        const task = await api.post<TaskSubmitResponse>('/tasks', {
          instruction: taskInstruction,
        });

        if (opts.json) {
          console.log(JSON.stringify(task));
        } else {
          console.log(`Task submitted: ${task.taskId}`);
          console.log(`Status: ${task.status}`);
        }

        if (opts.wait) {
          console.log('Streaming events (Ctrl+C to detach)...\n');
          await streamEvents(task.taskId, (event) => {
            printEvent(event, opts.json ?? false);
            if (event.type === 'task-completed' || event.type === 'task-failed') {
              process.exit(event.type === 'task-completed' ? 0 : 1);
            }
          });
        }
      } catch (err) {
        console.error('Failed to submit task:', (err as Error).message);
        process.exit(1);
      }
    });
}
