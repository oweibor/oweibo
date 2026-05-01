/**
 * oweibo ledger — usage ledger subcommands
 *
 * ledger list [--tenant <id>] [--date <YYYY-MM-DD>]
 */
import { Command } from 'commander';
import { api } from '../client.js';

export function makeLedgerCommand(): Command {
  const ledger = new Command('ledger').description('Usage and billing ledger');

  ledger
    .command('list')
    .description('List usage ledger entries for the current tenant')
    .option('--tenant <id>', 'Tenant ID (overrides OWEIBO_TENANT_ID)')
    .option('--date <date>', 'Date filter (YYYY-MM-DD)')
    .option('--json',        'Output raw JSON')
    .action(async (opts: { tenant?: string; date?: string; json?: boolean }) => {
      const qs = new URLSearchParams();
      const tid = opts.tenant ?? process.env['OWEIBO_TENANT_ID'];
      if (tid)      qs.set('tenantId', tid);
      if (opts.date) qs.set('date',    opts.date);
      const path = `/ledger${qs.toString() ? '?' + qs.toString() : ''}`;
      try {
        const result = await api.get<any>(path);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        const entries = result.entries ?? result.usage ?? [];
        if (entries.length === 0) { console.log('No ledger entries'); return; }
        for (const e of entries) {
          console.log(`  ${e.date ?? e.tenantId}  tasks: ${e.tasks_day ?? '—'}  tokens: ${e.tokens_day ?? '—'}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  return ledger;
}
