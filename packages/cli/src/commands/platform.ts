/**
 * oweibo platform — platform-admin subcommands
 *
 * platform tenant list
 * platform tenant create --name <n> --slug <s>
 * platform tenant get <id>
 * platform tenant update <id> [--name <n>] [--status <s>] [--trust <t>]
 * platform tenant suspend <id>
 * platform user list
 * platform user role <userId> <role,...>
 */
import { Command } from 'commander';
import { identityApi } from '../client.js';

function printRow(obj: Record<string, unknown>, keys: string[]) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) console.log(`  ${k}: ${v}`);
  }
}

function printList(items: Record<string, unknown>[], keys: string[]) {
  if (items.length === 0) { console.log('(none)'); return; }
  for (const item of items) {
    printRow(item, keys);
    console.log('');
  }
}

export function makePlatformCommand(): Command {
  const platform = new Command('platform')
    .description('Platform-administration commands (platform_admin only)');

  // ── platform tenant ───────────────────────────────────────────────────────

  const tenant = new Command('tenant').description('Manage tenants');

  tenant
    .command('list')
    .description('List all tenants')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await identityApi.get<{ tenants: any[] }>('/api/v1/platform/tenants');
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        printList(result.tenants, ['id', 'name', 'slug', 'status', 'createdAt']);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  tenant
    .command('create')
    .description('Create a new tenant')
    .requiredOption('--name <name>', 'Tenant display name')
    .requiredOption('--slug <slug>', 'URL slug (lowercase alphanumeric + hyphens)')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { name: string; slug: string; json?: boolean }) => {
      try {
        const result = await identityApi.post<{ tenant: any }>('/api/v1/platform/tenants', {
          name: opts.name, slug: opts.slug,
        });
        if (opts.json) { console.log(JSON.stringify(result.tenant, null, 2)); return; }
        console.log(`Tenant created: ${result.tenant.id}`);
        printRow(result.tenant, ['id', 'name', 'slug', 'status']);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  tenant
    .command('get <id>')
    .description('Get tenant details')
    .option('--json', 'Output raw JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const result = await identityApi.get<{ tenant: any }>(`/api/v1/platform/tenants/${id}`);
        if (opts.json) { console.log(JSON.stringify(result.tenant, null, 2)); return; }
        printRow(result.tenant, ['id', 'name', 'slug', 'status', 'trustModeDefault', 'createdAt']);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  tenant
    .command('update <id>')
    .description('Update tenant attributes')
    .option('--name <name>',   'New display name')
    .option('--status <s>',    'Status: active | suspended | deleted')
    .option('--trust <mode>',  'Trust mode: supervised | graduated | autonomous')
    .option('--json',          'Output raw JSON')
    .action(async (id: string, opts: { name?: string; status?: string; trust?: string; json?: boolean }) => {
      const body: Record<string, string> = {};
      if (opts.name)   body['name']             = opts.name;
      if (opts.status) body['status']           = opts.status;
      if (opts.trust)  body['trustModeDefault'] = opts.trust;
      try {
        const result = await identityApi.patch<{ tenant: any }>(`/api/v1/platform/tenants/${id}`, body);
        if (opts.json) { console.log(JSON.stringify(result.tenant, null, 2)); return; }
        console.log('Tenant updated');
        printRow(result.tenant, ['id', 'name', 'slug', 'status', 'trustModeDefault']);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  tenant
    .command('suspend <id>')
    .description('Suspend a tenant')
    .option('--json', 'Output raw JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        const result = await identityApi.post<{ tenant: any }>(`/api/v1/platform/tenants/${id}/suspend`);
        if (opts.json) { console.log(JSON.stringify(result.tenant, null, 2)); return; }
        console.log(`Tenant ${id} suspended`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  platform.addCommand(tenant);

  // ── platform user ──────────────────────────────────────────────────────────

  const user = new Command('user').description('Manage platform users');

  user
    .command('list')
    .description('List all platform users')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await identityApi.get<{ users: any[] }>('/api/v1/platform/users');
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        printList(result.users, ['id', 'email', 'platformRoles', 'status']);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  user
    .command('role <userId> <roles>')
    .description('Set platform roles for a user (comma-separated: platform_admin,platform_operator,platform_billing)')
    .option('--json', 'Output raw JSON')
    .action(async (userId: string, rolesArg: string, opts: { json?: boolean }) => {
      const roles = rolesArg.split(',').map(r => r.trim()).filter(Boolean);
      try {
        const result = await identityApi.post<{ user: any }>(
          `/api/v1/platform/users/${userId}/roles`, { roles },
        );
        if (opts.json) { console.log(JSON.stringify(result.user, null, 2)); return; }
        console.log(`Roles updated for ${userId}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  platform.addCommand(user);

  return platform;
}
