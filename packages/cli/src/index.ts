#!/usr/bin/env node
/**
 * @oweibo/cli — oweibo command-line interface.
 *
 * Commands:
 *   login     Log in and store credentials
 *   logout    Clear credentials
 *   whoami    Show current authenticated user
 *   platform  Platform-administration commands (platform_admin only)
 *   tenant    Tenant administration commands
 *   task      Task management (submit, list, status, pause, cancel, clear)
 *   staging   Staging approval workflow
 *   quarantine Quarantine management
 *   scrape    Web scraping
 *   ledger    Usage ledger
 *   hitl      Human-in-the-loop management
 *   run       Submit a task and stream events (alias for task submit --wait)
 *   status    Show task status (alias for task status)
 *   redirect  Send a human intervention to a task
 *   session   Manage general-coding sessions
 *   config    View and set CLI configuration
 *   skills    Manage SKILL.md files
 *   browser   Control the agent browser session
 *   docs      Generate documentation for a codebase
 *
 * Environment variables:
 *   OWEIBO_API_URL       Pipeline API base URL (default: http://localhost:3100/api/v1)
 *   OWEIBO_IDENTITY_URL  Identity service URL  (default: http://localhost:3110)
 *   OWEIBO_API_KEY       Bearer token (overrides credentials file)
 *   OWEIBO_TENANT_ID     Default tenant ID
 *   OWEIBO_SESSION_ID    Default session ID
 */
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';

import { makeRunCommand }        from './commands/run.js';
import { makeStatusCommand }     from './commands/status.js';
import { makeRedirectCommand }   from './commands/redirect.js';
import { makeSessionCommand }    from './commands/session.js';
import { makeConfigCommand }     from './commands/config.js';
import { makeSkillsCommand }     from './commands/skills.js';
import { makeBrowserCommand }    from './commands/browser.js';
import { makeDocsCommand }       from './commands/docs.js';

// Phase 4 commands
import { makeLoginCommand, makeLogoutCommand, makeWhoamiCommand } from './commands/auth.js';
import { makePlatformCommand }   from './commands/platform.js';
import { makeTenantCommand }     from './commands/tenant.js';
import { makeTaskCommand }       from './commands/task.js';
import { makeStagingCommand }    from './commands/staging.js';
import { makeQuarantineCommand } from './commands/quarantine.js';
import { makeScrapeCommand }     from './commands/scrape.js';
import { makeLedgerCommand }     from './commands/ledger.js';
import { makeHitlCommand }       from './commands/hitl-cmd.js';

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.4.0';
  }
}

const program = new Command();

program
  .name('oweibo')
  .description('AI-powered autonomous app factory — command-line interface')
  .version(getVersion(), '-V, --version', 'Output the CLI version')
  .helpOption('-h, --help', 'Display help');

// ── Auth ──────────────────────────────────────────────────────────────────
program.addCommand(makeLoginCommand());
program.addCommand(makeLogoutCommand());
program.addCommand(makeWhoamiCommand());

// ── Resource families (Phase 4) ───────────────────────────────────────────
program.addCommand(makePlatformCommand());
program.addCommand(makeTenantCommand());
program.addCommand(makeTaskCommand());
program.addCommand(makeStagingCommand());
program.addCommand(makeQuarantineCommand());
program.addCommand(makeScrapeCommand());
program.addCommand(makeLedgerCommand());
program.addCommand(makeHitlCommand());

// ── Legacy top-level commands (preserved for backward compat) ─────────────
program.addCommand(makeRunCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeRedirectCommand());
program.addCommand(makeSessionCommand());
program.addCommand(makeConfigCommand());
program.addCommand(makeSkillsCommand());
program.addCommand(makeBrowserCommand());
program.addCommand(makeDocsCommand());

// pause / cancel (thin wrappers over task redirect)
program
  .command('pause <taskId>')
  .description('Pause a running task (alias for: task pause <taskId>)')
  .option('--json', 'Output raw JSON')
  .action(async (taskId: string, opts: { json?: boolean }) => {
    const { api } = await import('./client.js');
    try {
      const result = await api.post(`/tasks/${taskId}/redirect`, { type: 'pause' });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(`Task ${taskId} paused`);
    } catch (err) {
      console.error(`Failed to pause task ${taskId}:`, (err as Error).message);
      process.exit(1);
    }
  });

program
  .command('cancel <taskId>')
  .description('Cancel a running task (alias for: task cancel <taskId>)')
  .option('--json', 'Output raw JSON')
  .action(async (taskId: string, opts: { json?: boolean }) => {
    const { api } = await import('./client.js');
    try {
      const result = await api.post(`/tasks/${taskId}/redirect`, { type: 'cancel' });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(`Task ${taskId} cancelled`);
    } catch (err) {
      console.error(`Failed to cancel task ${taskId}:`, (err as Error).message);
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

if (process.argv.length <= 2) {
  program.help();
}
