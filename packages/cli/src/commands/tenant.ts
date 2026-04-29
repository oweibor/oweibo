/**
 * oweibo tenant — tenant-admin subcommands
 *
 * tenant member list
 * tenant member invite --email <e> --roles <r,...>
 * tenant member role <userId> <role,...>
 * tenant member remove <userId>
 * tenant key list
 * tenant key create --name <n> --scopes <s,...>
 * tenant key revoke <keyId>
 * tenant settings get
 * tenant settings set --trust <mode>
 */
import { Command } from 'commander';
import { identityApi } from '../client.js';

function tenantId(): string {
  return (
    process.env['OWEIBO_TENANT_ID'] ??
    (() => { console.error('OWEIBO_TENANT_ID is required (or use --tenant)'); process.exit(1); })()
  );
}

function withTenant(cmd: Command): Command {
  return cmd.option('--tenant <id>', 'Tenant ID (overrides OWEIBO_TENANT_ID)');
}

function resolveTenant(opts: { tenant?: string }): string {
  return opts.tenant ?? tenantId();
}

export function makeTenantCommand(): Command {
  const tenantCmd = new Command('tenant')
    .description('Tenant administration commands');

  // ── tenant member ────────────────────────────────────────────────────────

  const member = new Command('member').description('Manage tenant members');

  withTenant(member.command('list'))
    .description('List tenant members')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tid = resolveTenant(opts);
      try {
        const result = await identityApi.get<{ members: any[] }>(`/api/v1/tenants/${tid}/users`);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        if (result.members.length === 0) { console.log('No members'); return; }
        for (const m of result.members) {
          console.log(`  ${m.userId}  ${m.user?.email ?? ''}  roles: ${(m.roles ?? []).join(', ')}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  withTenant(member.command('invite'))
    .description('Invite a user to the tenant (user must already have an account)')
    .requiredOption('--email <email>', 'User email')
    .requiredOption('--roles <roles>', 'Comma-separated roles: tenant_admin,tenant_developer,tenant_viewer')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; email: string; roles: string; json?: boolean }) => {
      const tid   = resolveTenant(opts);
      const roles = opts.roles.split(',').map(r => r.trim()).filter(Boolean);
      try {
        const result = await identityApi.post<{ membership: any }>(
          `/api/v1/tenants/${tid}/users/invite`, { email: opts.email, roles },
        );
        if (opts.json) { console.log(JSON.stringify(result.membership, null, 2)); return; }
        console.log(`Invited ${opts.email} as ${roles.join(', ')}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  withTenant(member.command('role <userId> <roles>'))
    .description('Update roles for a tenant member')
    .option('--json', 'Output raw JSON')
    .action(async (userId: string, rolesArg: string, opts: { tenant?: string; json?: boolean }) => {
      const tid   = resolveTenant(opts);
      const roles = rolesArg.split(',').map(r => r.trim()).filter(Boolean);
      try {
        const result = await identityApi.post<{ membership: any }>(
          `/api/v1/tenants/${tid}/users/${userId}/roles`, { roles },
        );
        if (opts.json) { console.log(JSON.stringify(result.membership, null, 2)); return; }
        console.log(`Roles updated: ${roles.join(', ')}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  withTenant(member.command('remove <userId>'))
    .description('Remove a member from the tenant')
    .action(async (userId: string, opts: { tenant?: string }) => {
      const tid = resolveTenant(opts);
      try {
        await identityApi.delete(`/api/v1/tenants/${tid}/users/${userId}`);
        console.log(`Removed ${userId}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  tenantCmd.addCommand(member);

  // ── tenant key ───────────────────────────────────────────────────────────

  const key = new Command('key').description('Manage tenant API keys');

  withTenant(key.command('list'))
    .description('List API keys for the tenant')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tid = resolveTenant(opts);
      try {
        const result = await identityApi.get<{ keys: any[] }>(`/api/v1/tenants/${tid}/apikeys`);
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        if (result.keys.length === 0) { console.log('No API keys'); return; }
        for (const k of result.keys) {
          console.log(`  ${k.id}  name: ${k.name}  prefix: ${k.prefix}  scopes: ${(k.scopes ?? []).join(', ')}`);
          if (k.expiresAt) console.log(`    expires: ${k.expiresAt}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  withTenant(key.command('create'))
    .description('Create a new API key (secret shown once)')
    .requiredOption('--name <name>',     'Key display name')
    .requiredOption('--scopes <scopes>', 'Comma-separated scopes')
    .option('--expires <datetime>',      'Expiry ISO datetime (optional)')
    .option('--json',                    'Output raw JSON')
    .action(async (opts: { tenant?: string; name: string; scopes: string; expires?: string; json?: boolean }) => {
      const tid    = resolveTenant(opts);
      const scopes = opts.scopes.split(',').map(s => s.trim()).filter(Boolean);
      try {
        const result = await identityApi.post<{ key: any; secret: string }>(
          `/api/v1/tenants/${tid}/apikeys`,
          { name: opts.name, scopes, expiresAt: opts.expires },
        );
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
        console.log(`API key created: ${result.key.id}`);
        console.log(`Secret (copy now — shown once):`);
        console.log(`  ${result.secret}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  withTenant(key.command('revoke <keyId>'))
    .description('Revoke an API key')
    .action(async (keyId: string, opts: { tenant?: string }) => {
      const tid = resolveTenant(opts);
      try {
        await identityApi.post(`/api/v1/tenants/${tid}/apikeys/${keyId}/revoke`);
        console.log(`Key ${keyId} revoked`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  tenantCmd.addCommand(key);

  // ── tenant settings ───────────────────────────────────────────────────────

  const settings = new Command('settings').description('Manage tenant settings');

  withTenant(settings.command('get'))
    .description('Get tenant settings')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { tenant?: string; json?: boolean }) => {
      const tid = resolveTenant(opts);
      try {
        const result = await identityApi.get<{ settings: any }>(`/api/v1/tenants/${tid}/settings`);
        if (opts.json) { console.log(JSON.stringify(result.settings, null, 2)); return; }
        console.log(`trustModeDefault: ${result.settings.trustModeDefault}`);
        if (result.settings.features) {
          console.log(`features: ${JSON.stringify(result.settings.features)}`);
        }
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  withTenant(settings.command('set'))
    .description('Update tenant settings')
    .option('--trust <mode>',  'Trust mode: supervised | graduated | autonomous')
    .option('--json',          'Output raw JSON')
    .action(async (opts: { tenant?: string; trust?: string; json?: boolean }) => {
      const tid  = resolveTenant(opts);
      const body: Record<string, string> = {};
      if (opts.trust) body['trustModeDefault'] = opts.trust;
      if (Object.keys(body).length === 0) {
        console.error('Provide at least one option to update (e.g. --trust supervised)');
        process.exit(1);
      }
      try {
        const result = await identityApi.patch<{ settings: any }>(`/api/v1/tenants/${tid}/settings`, body);
        if (opts.json) { console.log(JSON.stringify(result.settings, null, 2)); return; }
        console.log('Settings updated');
        console.log(`trustModeDefault: ${result.settings.trustModeDefault}`);
      } catch (err: any) { console.error('Failed:', err.message); process.exit(1); }
    });

  tenantCmd.addCommand(settings);

  return tenantCmd;
}
