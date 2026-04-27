/**
 * Single source of truth for role → scope expansion.
 * Runtime checks compare resolved scope sets — no glob matching in middleware.
 */

export type Scope =
  | 'tasks:read' | 'tasks:write' | 'tasks:cancel'
  | 'staging:read' | 'staging:approve' | 'staging:reject'
  | 'quarantine:read' | 'quarantine:override'
  | 'scrape:read' | 'scrape:write' | 'scrape:delete'
  | 'hitl:read' | 'hitl:decide'
  | 'ledger:read' | 'ledger:write'
  | 'memory:read' | 'memory:write'
  | 'tenant:settings:read' | 'tenant:settings:write'
  | 'tenant:users:read'    | 'tenant:users:write'
  | 'tenant:apikeys:read'  | 'tenant:apikeys:write'
  | 'tenant:audit:read'
  | 'trust:graduated' | 'trust:autonomous'
  | 'platform:tenants:read'  | 'platform:tenants:write'
  | 'platform:users:read'    | 'platform:users:write'
  | 'platform:metrics:read'
  | 'platform:audit:read'
  | 'platform:config:write';

export type PlatformRole = 'platform_admin' | 'platform_operator' | 'platform_billing';
export type TenantRole   = 'tenant_admin' | 'tenant_developer' | 'tenant_viewer';
export type Role = PlatformRole | TenantRole;

const PLATFORM_SCOPES: Scope[] = [
  'platform:tenants:read', 'platform:tenants:write',
  'platform:users:read',   'platform:users:write',
  'platform:metrics:read', 'platform:audit:read',
  'platform:config:write',
];

const TENANT_ADMIN_SCOPES: Scope[] = [
  'tasks:read', 'tasks:write', 'tasks:cancel',
  'staging:read', 'staging:approve', 'staging:reject',
  'quarantine:read', 'quarantine:override',
  'scrape:read', 'scrape:write', 'scrape:delete',
  'hitl:read', 'hitl:decide',
  'ledger:read', 'ledger:write',
  'memory:read', 'memory:write',
  'tenant:settings:read', 'tenant:settings:write',
  'tenant:users:read',    'tenant:users:write',
  'tenant:apikeys:read',  'tenant:apikeys:write',
  'tenant:audit:read',
  'trust:graduated', 'trust:autonomous',
];

export const ROLE_SCOPES: Record<Role, Scope[]> = {
  platform_admin:    [...PLATFORM_SCOPES, ...TENANT_ADMIN_SCOPES],
  platform_operator: ['platform:tenants:read', 'platform:metrics:read', 'platform:audit:read'],
  platform_billing:  ['platform:tenants:read', 'platform:metrics:read'],

  tenant_admin: TENANT_ADMIN_SCOPES,

  tenant_developer: [
    'tasks:read', 'tasks:write', 'tasks:cancel',
    'staging:read', 'quarantine:read',
    'scrape:read', 'scrape:write',
    'hitl:read',
    'memory:read',
    'tenant:settings:read',
  ],

  tenant_viewer: [
    'tasks:read', 'staging:read', 'quarantine:read',
    'scrape:read', 'hitl:read', 'memory:read',
    'tenant:settings:read',
  ],
};

export function expandRoles(roles: string[]): Scope[] {
  const set = new Set<Scope>();
  for (const r of roles) {
    const scopes = ROLE_SCOPES[r as Role];
    if (scopes) scopes.forEach(s => set.add(s));
  }
  return [...set];
}
