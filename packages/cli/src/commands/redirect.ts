/**
 * oweibo redirect — send a human intervention message to a paused task.
 *
 * Usage:
 *   oweibo redirect <taskId> "use PostgreSQL not SQLite"
 *   oweibo redirect <taskId> --approve <requestId>
 *   oweibo redirect <taskId> --reject <requestId> "not approved"
 */
import { Command } from 'commander';
import { api } from '../client.js';

interface RedirectOptions {
  approve?: string;
  reject?: string;
  reason?: string;
  json?: boolean;
}

export function makeRedirectCommand(): Command {
  return new Command('redirect')
    .description('Send a human intervention message or HITL decision to a task')
    .argument('<taskId>', 'Target task ID')
    .argument('[message]', 'Free-text redirection instruction')
    .option('--approve <requestId>', 'Approve a HITL escalation request by ID')
    .option('--reject <requestId>', 'Reject a HITL escalation request by ID')
    .option('-r, --reason <text>', 'Reason for rejection (used with --reject)')
    .option('--json', 'Output raw JSON', false)
    .action(async (taskId: string, message: string | undefined, opts: RedirectOptions) => {
      try {
        if (opts.approve) {
          const result = await api.post(`/hitl/${opts.approve}/approve`, { reason: opts.reason });
          if (opts.json) console.log(JSON.stringify(result));
          else console.log(`✓ HITL request ${opts.approve} approved`);
          return;
        }

        if (opts.reject) {
          const result = await api.post(`/hitl/${opts.reject}/reject`, { reason: opts.reason });
          if (opts.json) console.log(JSON.stringify(result));
          else console.log(`✓ HITL request ${opts.reject} rejected`);
          return;
        }

        if (!message) {
          console.error('Error: Provide a message or use --approve / --reject');
          process.exit(1);
        }

        const result = await api.post(`/tasks/${taskId}/redirect`, { type: 'redirect', payload: message });
        if (opts.json) console.log(JSON.stringify(result));
        else console.log(`✓ Redirect sent to task ${taskId}`);
      } catch (err) {
        console.error(`Failed to redirect task ${taskId}:`, (err as Error).message);
        process.exit(1);
      }
    });
}
