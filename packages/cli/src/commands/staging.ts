/**
 * oweibo staging — staging-queue subcommands
 *
 * staging list
 * staging approve <id>
 * staging reject  <id> [--reason <r>]
 */
import { Command } from 'commander';
import { api } from '../client.js';

export function makeStagingCommand(): Command {
  const staging = new Command('staging').description('Staging approval workflow');

  staging
    .command('list')
    .description('List pending staged outputs')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await api.get<{ staged: any[]; count: number }>('/staging');
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        const items = result.staged ?? [];
        if (items.length === 0) { console.log('No staged items'); return; }
        for (const s of items) {
          console.log(`  ${s.id}  task: ${s.taskId}  created: ${s.createdAt ?? ''}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  staging
    .command('approve <id>')
    .description('Approve a staged output')
    .option('--json', 'Output raw JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const result = await api.post(`/staging/${id}/approve`);
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Approved: ${id}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  staging
    .command('reject <id>')
    .description('Reject a staged output')
    .option('--reason <reason>', 'Rejection reason')
    .option('--json',            'Output raw JSON')
    .action(async (id: string, opts: { reason?: string; json?: boolean }) => {
      try {
        const result = await api.post(`/staging/${id}/reject`, { reason: opts.reason });
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Rejected: ${id}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  return staging;
}
