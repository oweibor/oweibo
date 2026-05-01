/**
 * oweibo scrape — web-scraping subcommands
 *
 * scrape start <url> [--type <t>]
 * scrape list [--status <s>]
 * scrape status <jobId>
 * scrape stop   <jobId>
 * scrape results <jobId>
 */
import { Command } from 'commander';
import { api } from '../client.js';

export function makeScrapeCommand(): Command {
  const scrape = new Command('scrape').description('Web scraping');

  scrape
    .command('start <url>')
    .description('Start a new scrape job')
    .option('--type <type>',       'Extraction type (default: general)', 'general')
    .option('--collection <name>', 'Output Qdrant collection name')
    .option('--json',              'Output raw JSON')
    .action(async (url: string, opts: { type?: string; collection?: string; json?: boolean }) => {
      try {
        const result = await api.post<{ job_id: string; status: string }>('/scrape/start', {
          target_url:        url,
          extraction_type:   opts.type,
          output_collection: opts.collection,
        });
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(`Scrape job started: ${result.job_id}`);
        console.log(`Status: ${result.status}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  scrape
    .command('list')
    .description('List scrape jobs for the current tenant')
    .option('--status <status>', 'Filter by status')
    .option('--json',            'Output raw JSON')
    .action(async (opts: { status?: string; json?: boolean }) => {
      const path = opts.status ? `/scrape/jobs?status=${encodeURIComponent(opts.status)}` : '/scrape/jobs';
      try {
        const result = await api.get<{ jobs: any[]; count: number }>(path);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        const jobs = result.jobs ?? [];
        if (jobs.length === 0) { console.log('No scrape jobs'); return; }
        for (const j of jobs) {
          console.log(`  ${j.job_id}  status: ${j.status}  url: ${j.target_url ?? ''}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  scrape
    .command('status <jobId>')
    .description('Get status of a scrape job')
    .option('--json', 'Output raw JSON')
    .action(async (jobId: string, opts: { json?: boolean }) => {
      try {
        const result = await api.get<any>(`/scrape/status/${jobId}`);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(`Job:      ${jobId}`);
        console.log(`Status:   ${result.status}`);
        if (result.progress) console.log(`Progress: ${JSON.stringify(result.progress)}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  scrape
    .command('stop <jobId>')
    .description('Stop a running scrape job')
    .option('--json', 'Output raw JSON')
    .action(async (jobId: string, opts: { json?: boolean }) => {
      try {
        const result = await api.post<any>(`/scrape/stop/${jobId}`);
        if (opts.json) { console.log(JSON.stringify(result)); return; }
        console.log(`Job ${jobId} stopped`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  scrape
    .command('results <jobId>')
    .description('Get extracted results for a scrape job')
    .option('--json', 'Output raw JSON')
    .action(async (jobId: string, opts: { json?: boolean }) => {
      try {
        const result = await api.get<any>(`/scrape/results/${jobId}`);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(`Job:        ${jobId}`);
        console.log(`Status:     ${result.status}`);
        if (result.results) {
          console.log(`Categories: ${result.results.categories_found}`);
          console.log(`Products:   ${result.results.products_extracted}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  return scrape;
}
