/**
 * oweibo session — manage conversation sessions for general-coding mode.
 *
 * Usage:
 *   oweibo session new                     — start a new session
 *   oweibo session list                    — list active sessions
 *   oweibo session resume <sessionId>      — resume a session
 *   oweibo session end <sessionId>         — end a session gracefully
 */
import { Command } from 'commander';
import { api } from '../client.js';

interface Session {
  sessionId: string;
  tenantId: string;
  status: string;
  createdAt: string;
  lastActivityAt?: string;
  taskCount?: number;
}

export function makeSessionCommand(): Command {
  const session = new Command('session')
    .description('Manage oweibo conversation sessions');

  session
    .command('new')
    .description('Start a new session for general-coding mode')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('-r, --repo <path>', 'Repository root path to bind to this session')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; repo?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'] ?? 'default';
      try {
        const sess = await api.post<Session>('/sessions', { tenantId, repoRoot: opts.repo });
        if (opts.json) console.log(JSON.stringify(sess));
        else {
          console.log(`Session created: ${sess.sessionId}`);
          console.log(`Status: ${sess.status}`);
          console.log(`\nSet OWEIBO_SESSION_ID=${sess.sessionId} to use this session.`);
        }
      } catch (err) {
        console.error('Failed to create session:', (err as Error).message);
        process.exit(1);
      }
    });

  session
    .command('list')
    .description('List active sessions')
    .option('-t, --tenant <id>', 'Filter by tenant ID')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tenantId = opts.tenant ?? process.env['OWEIBO_TENANT_ID'];
      try {
        const sessions = await api.get<Session[]>(`/sessions${tenantId ? `?tenantId=${tenantId}` : ''}`);
        if (opts.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else if (sessions.length === 0) {
          console.log('No active sessions.');
        } else {
          console.log('Active sessions:\n');
          for (const s of sessions) {
            const last = s.lastActivityAt ? new Date(s.lastActivityAt).toLocaleString() : 'never';
            console.log(`  ${s.sessionId}  [${s.status}]  tasks: ${s.taskCount ?? 0}  last: ${last}`);
          }
        }
      } catch (err) {
        console.error('Failed to list sessions:', (err as Error).message);
        process.exit(1);
      }
    });

  session
    .command('resume <sessionId>')
    .description('Resume an existing session')
    .option('--json', 'Output raw JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      try {
        const sess = await api.post<Session>(`/sessions/${sessionId}/resume`);
        if (opts.json) console.log(JSON.stringify(sess));
        else {
          console.log(`Session ${sessionId} resumed.`);
          console.log(`Set OWEIBO_SESSION_ID=${sessionId} to continue working.`);
        }
      } catch (err) {
        console.error(`Failed to resume session ${sessionId}:`, (err as Error).message);
        process.exit(1);
      }
    });

  session
    .command('end <sessionId>')
    .description('End a session gracefully (commits pending changes)')
    .option('--json', 'Output raw JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
      try {
        const result = await api.post<{ ended: boolean; commitHash?: string }>(`/sessions/${sessionId}/end`);
        if (opts.json) console.log(JSON.stringify(result));
        else {
          console.log(`Session ${sessionId} ended.`);
          if (result.commitHash) console.log(`Final commit: ${result.commitHash}`);
        }
      } catch (err) {
        console.error(`Failed to end session ${sessionId}:`, (err as Error).message);
        process.exit(1);
      }
    });

  return session;
}
