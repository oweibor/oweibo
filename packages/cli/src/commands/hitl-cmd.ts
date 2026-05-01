/**
 * oweibo hitl — human-in-the-loop subcommands
 *
 * hitl list
 * hitl approve <requestId>
 * hitl reject  <requestId> [--reason <r>]
 */
import { Command } from 'commander';
import { api } from '../client.js';

export interface HITLRequest {
  requestId:   string;
  taskId:      string;
  reason:      string;
  escalatedAt: string;
}

export function makeHitlCommand(): Command {
  const hitl = new Command('hitl').description('Human-in-the-loop management');

  hitl
    .command('list')
    .description('List pending HITL escalation requests')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await api.get<{ count: number; requests: HITLRequest[] }>('/hitl/pending');
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        if (result.requests.length === 0) { console.log('No pending HITL requests'); return; }
        console.log(`Pending HITL requests (${result.requests.length}):\n`);
        for (const r of result.requests) {
          console.log(`  ${r.requestId}  task: ${r.taskId}  "${r.reason}"`);
          console.log(`    Escalated: ${new Date(r.escalatedAt).toLocaleString()}`);
          console.log(`    Approve:   oweibo hitl approve ${r.requestId}`);
          console.log(`    Reject:    oweibo hitl reject  ${r.requestId}\n`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  hitl
    .command('approve <requestId>')
    .description('Approve a HITL escalation request')
    .option('--task <taskId>', 'Task ID (required if not in request context)')
    .option('--json',          'Output raw JSON')
    .action(async (requestId: string, opts: { task?: string; json?: boolean }) => {
      try {
        const taskId = opts.task ?? requestId; // fallback: use requestId as taskId hint
        const result = await api.post(`/tasks/${taskId}/redirect`, {
          type: 'approve',
          requestId,
        });
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Approved HITL request ${requestId}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  hitl
    .command('reject <requestId>')
    .description('Reject a HITL escalation request')
    .option('--task <taskId>',   'Task ID (required if not in request context)')
    .option('--reason <reason>', 'Rejection reason')
    .option('--json',            'Output raw JSON')
    .action(async (requestId: string, opts: { task?: string; reason?: string; json?: boolean }) => {
      try {
        const taskId = opts.task ?? requestId;
        const result = await api.post(`/tasks/${taskId}/redirect`, {
          type: 'reject',
          requestId,
          reason: opts.reason,
        });
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Rejected HITL request ${requestId}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  return hitl;
}
