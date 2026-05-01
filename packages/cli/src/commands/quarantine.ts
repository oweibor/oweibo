/**
 * oweibo quarantine — quarantine management subcommands
 *
 * quarantine list
 * quarantine override <id> [--reason <r>]
 */
import { Command } from 'commander';
import { api } from '../client.js';

export function makeQuarantineCommand(): Command {
  const quarantine = new Command('quarantine').description('Quarantine management');

  quarantine
    .command('list')
    .description('List quarantined items')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await api.get<{ quarantined: any[]; count: number }>('/quarantine');
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        const items = result.quarantined ?? [];
        if (items.length === 0) { console.log('No quarantined items'); return; }
        for (const q of items) {
          console.log(`  ${q.id}  task: ${q.taskId}  reason: ${q.reason ?? ''}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  quarantine
    .command('override <id>')
    .description('Override quarantine and release an item')
    .option('--reason <reason>', 'Override reason (required for audit)')
    .option('--json',            'Output raw JSON')
    .action(async (id: string, opts: { reason?: string; json?: boolean }) => {
      try {
        const result = await api.post(`/quarantine/${id}/override`, { reason: opts.reason });
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Override applied: ${id}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  return quarantine;
}
