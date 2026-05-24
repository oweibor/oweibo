/**
 * oweibo forensics — S.7 forensic packet + replay subcommands.
 *
 *   forensics list                          — list packets for current tenant
 *   forensics show <packetId>               — print packet detail
 *   forensics resolve <packetId> <resolution> [--notes <s>]
 *   forensics replay <planId> [--kind shadow_full|shadow_step|what_if]
 *
 * All subcommands hit the pipeline API; the actual packet bytes live in
 * object storage and are not transferred to the CLI by default — use
 * `show --download` to fetch the raw bytes for offline review.
 */
import { Command } from 'commander';
import { api } from '../client.js';

interface PacketRow {
  id: string;
  planId: string;
  triggerKind: string;
  state: string;
  summary: string | null;
  createdAt: string;
}

interface PacketDetail {
  id: string;
  planId: string;
  summary: string | null;
  triggerKind: string;
  state: string;
  storageRef: string;
  signature: string;
  createdAt: string;
  expiresAt: string;
  proposals: Array<{ proposalId: string; actionClass: string; mode: string; state: string }>;
  executions: Array<{ proposalId: string; outcome: 'success' | 'failure' }>;
  verifications: Array<{ verifierName: string; driftSeverity: number }>;
  rollbacks: Array<{ originalActionId: string; resultState: string | null }>;
  suggestedActions: string[];
}

interface ReplayResult {
  runId: string;
  status: 'complete' | 'failed';
  totalSteps: number;
  matchingSteps: number;
  mismatchSteps: number;
  failureReason?: string;
}

export function makeForensicsCommand(): Command {
  const cmd = new Command('forensics').description('Forensic packet + replay operations');

  cmd
    .command('list')
    .description('List forensic packets for the current tenant')
    .option('--limit <n>', 'Max packets to return', '50')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { limit?: string; json?: boolean }) => {
      try {
        const limit = parseInt(opts.limit ?? '50', 10);
        const res = await api.get<{ packets: PacketRow[] }>(`/forensics?limit=${limit}`);
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
        const packets = res.packets ?? [];
        if (packets.length === 0) { console.log('No forensic packets.'); return; }
        console.log(`Forensic packets (${packets.length}):\n`);
        for (const p of packets) {
          console.log(`  ${p.id.slice(0, 8)}…  [${p.state.padEnd(13)}]  ${p.triggerKind.padEnd(22)}  plan ${p.planId.slice(0, 8)}…`);
          console.log(`    created: ${new Date(p.createdAt).toLocaleString()}`);
          if (p.summary) console.log(`    summary: ${p.summary}`);
          console.log();
        }
      } catch (err: any) {
        console.error('Failed:', err.message);
        process.exit(1);
      }
    });

  cmd
    .command('show <packetId>')
    .description('Print the detail of a single forensic packet')
    .option('--json', 'Output raw JSON')
    .action(async (packetId: string, opts: { json?: boolean }) => {
      try {
        const res = await api.get<{ packet: PacketDetail }>(`/forensics/${packetId}`);
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
        const p = res.packet;
        if (!p) { console.error(`Packet ${packetId} not found`); process.exit(1); return; }
        console.log(`Forensic packet ${p.id}`);
        console.log(`  plan:        ${p.planId}`);
        console.log(`  trigger:     ${p.triggerKind}`);
        console.log(`  state:       ${p.state}`);
        console.log(`  created:     ${new Date(p.createdAt).toLocaleString()}`);
        console.log(`  expires:     ${new Date(p.expiresAt).toLocaleString()}`);
        console.log(`  storage:     ${p.storageRef}`);
        console.log(`  signature:   ${p.signature.slice(0, 16)}…`);
        if (p.summary) console.log(`  summary:     ${p.summary}`);
        console.log(`\nProposals (${p.proposals.length}):`);
        for (const x of p.proposals) {
          console.log(`  ${x.proposalId.slice(0, 8)}…  ${x.actionClass.padEnd(28)}  ${x.mode.padEnd(16)}  ${x.state}`);
        }
        console.log(`\nExecutions (${p.executions.length}):`);
        for (const x of p.executions) {
          console.log(`  ${x.proposalId.slice(0, 8)}…  ${x.outcome}`);
        }
        console.log(`\nVerifications (${p.verifications.length}):`);
        for (const x of p.verifications) {
          console.log(`  ${x.verifierName.padEnd(30)}  sev ${x.driftSeverity}`);
        }
        console.log(`\nRollbacks (${p.rollbacks.length}):`);
        for (const x of p.rollbacks) {
          console.log(`  ${x.originalActionId.slice(0, 8)}…  ${x.resultState ?? 'pending'}`);
        }
        if (p.suggestedActions.length > 0) {
          console.log(`\nSuggested actions:`);
          for (const s of p.suggestedActions) console.log(`  - ${s}`);
        }
      } catch (err: any) {
        console.error('Failed:', err.message);
        process.exit(1);
      }
    });

  cmd
    .command('resolve <packetId> <resolution>')
    .description('Resolve an open packet (resumed|overridden|aborted|lessons_learned)')
    .option('--notes <s>', 'Resolution notes')
    .option('--json', 'Output raw JSON')
    .action(async (packetId: string, resolution: string, opts: { notes?: string; json?: boolean }) => {
      const allowed = ['resumed', 'overridden', 'aborted', 'lessons_learned'];
      if (!allowed.includes(resolution)) {
        console.error(`Resolution must be one of: ${allowed.join(', ')}`);
        process.exit(1);
      }
      try {
        const res = await api.post(`/forensics/${packetId}/resolve`, {
          resolution,
          notes: opts.notes ?? '',
        });
        if (opts.json) { console.log(JSON.stringify(res)); return; }
        console.log(`Packet ${packetId} resolved as ${resolution}`);
      } catch (err: any) {
        console.error('Failed:', err.message);
        process.exit(1);
      }
    });

  cmd
    .command('replay <planId>')
    .description('Replay a plan in shadow mode (NEVER invokes real execute())')
    .option('--kind <k>', 'Replay kind: shadow_full | shadow_step | what_if', 'shadow_full')
    .option('--proposal <id>', 'Proposal id (for shadow_step)')
    .option('--mutation <json>', 'Mutation JSON: {"path":"...","newValue":...}')
    .option('--json', 'Output raw JSON')
    .action(async (planId: string, opts: { kind?: string; proposal?: string; mutation?: string; json?: boolean }) => {
      const allowed = ['shadow_full', 'shadow_step', 'what_if'];
      const kind = opts.kind ?? 'shadow_full';
      if (!allowed.includes(kind)) {
        console.error(`--kind must be one of: ${allowed.join(', ')}`);
        process.exit(1);
      }
      let mutation: unknown = undefined;
      if (opts.mutation) {
        try { mutation = JSON.parse(opts.mutation); }
        catch { console.error('--mutation must be valid JSON'); process.exit(1); }
      }
      try {
        const res = await api.post<ReplayResult>(`/forensics/replay`, {
          planId,
          kind,
          ...(opts.proposal ? { proposalId: opts.proposal } : {}),
          ...(mutation !== undefined ? { mutation } : {}),
        });
        if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
        console.log(`Replay ${res.runId}: ${res.status}`);
        console.log(`  total:    ${res.totalSteps}`);
        console.log(`  matching: ${res.matchingSteps}`);
        console.log(`  mismatch: ${res.mismatchSteps}`);
        if (res.failureReason) console.log(`  reason:   ${res.failureReason}`);
      } catch (err: any) {
        console.error('Failed:', err.message);
        process.exit(1);
      }
    });

  return cmd;
}
