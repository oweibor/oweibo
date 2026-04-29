/**
 * oweibo login / logout / whoami
 *
 * login   — email + password → stores access_token + refresh_token in ~/.oweibo/credentials
 * logout  — clears credentials file and notifies the identity service
 * whoami  — shows current user from the JWT /me endpoint
 */
import { Command } from 'commander';
import { createInterface } from 'readline';
import { identityApi } from '../client.js';
import {
  writeCredentials,
  clearCredentials,
  readCredentials,
  type Credentials,
} from '../credentials.js';

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      process.stdin.setRawMode?.(true);
      let answer = '';
      process.stdin.on('data', (ch: Buffer) => {
        const char = ch.toString();
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode?.(false);
          process.stdout.write('\n');
          rl.close();
          resolve(answer);
        } else if (char === '') {
          process.stdin.setRawMode?.(false);
          process.exit(1);
        } else {
          answer += char;
        }
      });
    } else {
      rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
    }
  });
}

// ── login ──────────────────────────────────────────────────────────────────

export function makeLoginCommand(): Command {
  return new Command('login')
    .description('Log in to oweibo and store credentials locally')
    .option('--email <email>',    'Email address (prompts if omitted)')
    .option('--tenant <id>',      'Preferred tenant ID')
    .option('--json',             'Output raw JSON')
    .action(async (opts: { email?: string; tenant?: string; json?: boolean }) => {
      let email = opts.email;
      if (!email) email = await prompt('Email: ');
      const password = await prompt('Password: ', true);

      if (!email || !password) {
        console.error('Email and password are required');
        process.exit(1);
      }

      try {
        const result = await identityApi.post<Credentials & { scopes: string[] }>(
          '/api/v1/auth/token',
          { email, password, tenantId: opts.tenant },
        );

        writeCredentials({
          access_token:  result.access_token,
          refresh_token: result.refresh_token,
          expires_at:    result.expires_at,
          token_type:    result.token_type ?? 'Bearer',
          user_id:       result.user_id,
          tenant_id:     result.tenant_id,
          email:         result.email,
          scopes:        result.scopes ?? [],
        });

        if (opts.json) {
          const { refresh_token: _r, access_token: _a, ...safe } = result as any;
          console.log(JSON.stringify(safe, null, 2));
        } else {
          console.log(`Logged in as ${result.email}`);
          if (result.tenant_id) console.log(`Tenant: ${result.tenant_id}`);
          console.log(`Scopes: ${(result.scopes ?? []).length} granted`);
        }
      } catch (err: any) {
        if (err?.status === 401) {
          console.error('Invalid email or password');
        } else {
          console.error('Login failed:', err.message);
        }
        process.exit(1);
      }
    });
}

// ── logout ─────────────────────────────────────────────────────────────────

export function makeLogoutCommand(): Command {
  return new Command('logout')
    .description('Log out and clear locally stored credentials')
    .action(async () => {
      // Best-effort server-side logout (JWT is stateless; mainly for future revocation)
      try { await identityApi.post('/api/v1/auth/logout'); } catch { /* ignore */ }
      clearCredentials();
      console.log('Logged out');
    });
}

// ── whoami ─────────────────────────────────────────────────────────────────

export function makeWhoamiCommand(): Command {
  return new Command('whoami')
    .description('Show current authenticated user')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      const creds = readCredentials();
      if (!creds) {
        console.error('Not logged in — run: oweibo login');
        process.exit(1);
      }
      try {
        const result = await identityApi.get<{
          user_id: string; email: string; tenant_id: string; scopes: string[];
        }>('/api/v1/auth/me');
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`User:   ${result.email}  (${result.user_id})`);
          console.log(`Tenant: ${result.tenant_id ?? '—'}`);
          console.log(`Scopes: ${result.scopes.join(', ')}`);
        }
      } catch (err: any) {
        console.error('Failed to get user info:', err.message);
        process.exit(1);
      }
    });
}
