/**
 * oweibo browser — CLI subcommands for the BrowserTool (v9.5.9).
 *
 * Subcommands:
 *   open <url>              Open a URL in the agent browser session (auto backend)
 *   import-cookies <domain> Import real Chrome cookies for a domain into the session
 *   autofill [selector]     Trigger Chrome password-manager autofill on the current page
 *   pair                    Pair the Oweibo Chrome extension via deep-link (one click)
 *
 * All subcommands submit a task to the pipeline API, which runs the corresponding
 * BrowserAction through BrowserTool.execute() inside the agent.
 *
 * Backend defaults to 'auto' — BrowserSessionRouter selects the optimal backend.
 */
import { Command } from 'commander';
import { api } from '../client.js';
import { streamEvents, printEvent } from '../sse.js';

interface BrowserOpenOptions {
  tenant?:  string;
  backend?: string;
  wait?:    boolean;
  json?:    boolean;
}

interface BrowserActionOptions {
  tenant?: string;
  json?:   boolean;
}

interface TaskResponse {
  taskId: string;
  status: string;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function submitBrowserAction(
  action:  Record<string, unknown>,
  opts:    { tenant?: string; json?: boolean; wait?: boolean },
): Promise<void> {
  const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
  try {
    const task = await api.post<TaskResponse>('/tasks', {
      instruction:  `[browser-action] ${action['type'] as string}`,
      tenantId,
      mode:         'browser',
      browserAction: action,
    });

    if (opts.json) {
      console.log(JSON.stringify(task));
    } else {
      console.log(`Task: ${task.taskId}  Status: ${task.status}`);
    }

    if (opts.wait) {
      console.log('Streaming events (Ctrl+C to detach)…\n');
      await streamEvents(task.taskId, (ev) => {
        printEvent(ev, opts.json ?? false);
        if (ev.type === 'task-completed' || ev.type === 'task-failed') {
          process.exit(ev.type === 'task-completed' ? 0 : 1);
        }
      });
    }
  } catch (err) {
    console.error('Failed to submit browser action:', (err as Error).message);
    process.exit(1);
  }
}

// ── Command builder ───────────────────────────────────────────────────────────

export function makeBrowserCommand(): Command {
  const browser = new Command('browser')
    .description('Control the agent browser session');

  // ── open ────────────────────────────────────────────────────────────────────
  browser
    .command('open <url>')
    .description('Open a URL in the agent browser (backend: auto)')
    .option('-t, --tenant <id>',    'Tenant ID', process.env['OWEIBO_TENANT_ID'] ?? 'default')
    .option('--backend <type>',     'Backend override: auto|local|extension|persistent|browserbase|brightdata', 'auto')
    .option('-w, --wait',           'Stream events until task completes', false)
    .option('--json',               'Output raw JSON', false)
    .action(async (url: string, opts: BrowserOpenOptions) => {
      await submitBrowserAction(
        { type: 'navigate', url, backend: opts.backend ?? 'auto' },
        opts,
      );
    });

  // ── import-cookies ──────────────────────────────────────────────────────────
  browser
    .command('import-cookies <domain>')
    .description('Import real Chrome cookies for a domain into the active session (extension mode)')
    .option('-t, --tenant <id>', 'Tenant ID', process.env['OWEIBO_TENANT_ID'] ?? 'default')
    .option('-w, --wait',        'Stream events until task completes', false)
    .option('--json',            'Output raw JSON', false)
    .action(async (domain: string, opts: BrowserActionOptions & { wait?: boolean }) => {
      await submitBrowserAction({ type: 'import-cookies', domain }, opts);
    });

  // ── autofill ────────────────────────────────────────────────────────────────
  browser
    .command('autofill [selector]')
    .description('Trigger Chrome password-manager autofill on the current page (extension mode)')
    .option('-t, --tenant <id>',   'Tenant ID', process.env['OWEIBO_TENANT_ID'] ?? 'default')
    .option('--no-submit',         'Do not submit the form after autofill')
    .option('-w, --wait',          'Stream events until task completes', false)
    .option('--json',              'Output raw JSON', false)
    .action(async (selector: string | undefined, opts: BrowserActionOptions & { submit?: boolean; wait?: boolean }) => {
      await submitBrowserAction(
        {
          type:             'autofill-credentials',
          usernameSelector: selector,
          submitAfterFill:  opts.submit !== false,
        },
        opts,
      );
    });

  // ── pair ────────────────────────────────────────────────────────────────────
  browser
    .command('pair')
    .description('Pair the Oweibo Chrome extension via deep-link (opens pair.html in your browser)')
    .option('-t, --tenant <id>', 'Tenant ID', process.env['OWEIBO_TENANT_ID'] ?? 'default')
    .option('--json',            'Output raw JSON', false)
    .action(async (opts: BrowserActionOptions) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const result = await api.post<{ pairingToken: string; deepLink: string }>(
          '/browser/pair',
          { tenantId },
        );
        if (opts.json) {
          console.log(JSON.stringify(result));
          return;
        }
        if (result.deepLink) {
          console.log(`Opening pair page: ${result.deepLink}`);
          // Open the deep link in the default OS browser.
          const { exec } = await import('child_process');
          const open =
            process.platform === 'darwin'  ? 'open' :
            process.platform === 'win32'   ? 'start' : 'xdg-open';
          exec(`${open} "${result.deepLink}"`, (err) => {
            if (err) console.error('Could not open browser:', err.message);
            else     console.log('Extension pairing page opened. Click Connect in the browser.');
          });
        } else {
          console.log(`Pairing token: ${result.pairingToken}`);
          console.log('Open the Oweibo extension popup and click Pair.');
        }
      } catch (err) {
        console.error('Failed to initiate pairing:', (err as Error).message);
        process.exit(1);
      }
    });

  return browser;
}
