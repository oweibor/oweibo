#!/usr/bin/env node
/**
 * @oweibo/cli — oweibo command-line interface.
 *
 * Commands:
 *   run       Submit a task and stream events
 *   status    Show task status
 *   redirect  Send a human intervention to a task
 *   session   Manage general-coding sessions
 *   config    View and set CLI configuration
 *   skills    Manage SKILL.md files (9 subcommands)
 *   browser   Control the agent browser session (open, import-cookies, autofill, pair)
 *   docs      Generate comprehensive documentation for any codebase
 *
 * Environment variables:
 *   OWEIBO_API_URL    API base URL (default: http://localhost:3100/api/v1)
 *   OWEIBO_API_KEY    Bearer token for authentication
 *   OWEIBO_TENANT_ID  Default tenant ID
 *   OWEIBO_SESSION_ID Default session ID for general-coding commands
 */
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';

import { makeRunCommand }      from './commands/run.js';
import { makeStatusCommand }   from './commands/status.js';
import { makeRedirectCommand } from './commands/redirect.js';
import { makeSessionCommand }  from './commands/session.js';
import { makeConfigCommand }   from './commands/config.js';
import { makeSkillsCommand }   from './commands/skills.js';
import { makeBrowserCommand }  from './commands/browser.js';
import { makeDocsCommand }     from './commands/docs.js';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.1.0';
  }
}

const program = new Command();

program
  .name('oweibo')
  .description('AI-powered autonomous app factory — command-line interface')
  .version(getVersion(), '-V, --version', 'Output the CLI version')
  .helpOption('-h, --help', 'Display help');

program.addCommand(makeRunCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeRedirectCommand());
program.addCommand(makeSessionCommand());
program.addCommand(makeConfigCommand());
program.addCommand(makeSkillsCommand());
program.addCommand(makeBrowserCommand());
program.addCommand(makeDocsCommand());

// Pause / cancel commands (thin wrappers over POST /tasks/:id/redirect)
program
  .command('pause <taskId>')
  .description('Pause a running task (can be resumed via redirect)')
  .option('--json', 'Output raw JSON')
  .action(async (taskId: string, opts: { json?: boolean }) => {
    const { api } = await import('./client.js');
    try {
      const result = await api.post(`/tasks/${taskId}/redirect`, { type: 'pause' });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(`✓ Task ${taskId} paused`);
    } catch (err) {
      console.error(`Failed to pause task ${taskId}:`, (err as Error).message);
      process.exit(1);
    }
  });

program
  .command('cancel <taskId>')
  .description('Cancel a running task')
  .option('--json', 'Output raw JSON')
  .action(async (taskId: string, opts: { json?: boolean }) => {
    const { api } = await import('./client.js');
    try {
      const result = await api.post(`/tasks/${taskId}/redirect`, { type: 'cancel' });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(`✓ Task ${taskId} cancelled`);
    } catch (err) {
      console.error(`Failed to cancel task ${taskId}:`, (err as Error).message);
      process.exit(1);
    }
  });

// Show pending HITL requests as a convenience shortcut
program
  .command('hitl')
  .description('List pending HITL (human-in-the-loop) escalation requests for your tenant')
  .option('--json', 'Output raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const { api } = await import('./client.js');
    try {
      interface HITLRequest { requestId: string; taskId: string; reason: string; escalatedAt: string; }
      const result = await api.get<{ count: number; requests: HITLRequest[] }>('/hitl/pending');
      const requests = result.requests;
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
      if (requests.length === 0) { console.log('No pending HITL requests.'); return; }
      console.log(`Pending HITL requests (${requests.length}):\n`);
      for (const r of requests) {
        console.log(`  ${r.requestId}  task: ${r.taskId}  "${r.reason}"`);
        console.log(`    Escalated: ${new Date(r.escalatedAt).toLocaleString()}`);
        console.log(`    Approve:   oweibo redirect ${r.taskId} --approve ${r.requestId}`);
        console.log(`    Reject:    oweibo redirect ${r.taskId} --reject ${r.requestId}\n`);
      }
    } catch (err) {
      console.error('Failed to list HITL requests:', (err as Error).message);
      process.exit(1);
    }
  });

// Unknown command handler
program.on('command:*', () => {
  console.error(`Unknown command: ${program.args.join(' ')}`);
  console.error(`Run 'oweibo --help' for available commands.`);
  process.exit(1);
});

program.parse(process.argv);

// Show help if no command provided
if (process.argv.length <= 2) {
  program.help();
}
