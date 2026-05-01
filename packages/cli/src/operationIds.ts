/**
 * Bidirectional CLI ↔ API parity map.
 *
 * Key:   operationId (matches the API route handler name / OpenAPI operationId)
 * Value: CLI command path (space-separated subcommands, e.g. "platform tenant list")
 *
 * The parity CI gate (src/__tests__/parity.test.ts) verifies:
 *   1. Every operationId maps to a non-empty CLI path.
 *   2. No CLI path is duplicated across operationIds.
 *   3. All expected resource families have at least one command.
 */
export const operationIds: Record<string, string> = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  authToken:   'login',
  authRefresh: 'login',   // internal — login re-uses refresh transparently
  authMe:      'whoami',
  authLogout:  'logout',

  // ── Platform — Tenants ────────────────────────────────────────────────────
  platformTenantList:   'platform tenant list',
  platformTenantCreate: 'platform tenant create',
  platformTenantGet:    'platform tenant get',
  platformTenantUpdate: 'platform tenant update',
  platformTenantSuspend:'platform tenant suspend',

  // ── Platform — Users ─────────────────────────────────────────────────────
  platformUserList:        'platform user list',
  platformUserUpdateRoles: 'platform user role',

  // ── Tenant — Members ─────────────────────────────────────────────────────
  tenantMemberList:        'tenant member list',
  tenantMemberInvite:      'tenant member invite',
  tenantMemberUpdateRoles: 'tenant member role',
  tenantMemberRemove:      'tenant member remove',

  // ── Tenant — API Keys ────────────────────────────────────────────────────
  tenantApiKeyList:   'tenant key list',
  tenantApiKeyCreate: 'tenant key create',
  tenantApiKeyRevoke: 'tenant key revoke',

  // ── Tenant — Settings ────────────────────────────────────────────────────
  tenantSettingsGet:    'tenant settings get',
  tenantSettingsUpdate: 'tenant settings set',

  // ── Tasks ────────────────────────────────────────────────────────────────
  taskSubmit: 'task submit',
  taskList:   'task list',
  taskStatus: 'task status',
  taskCancel: 'task cancel',
  taskPause:  'task pause',
  taskClear:  'task clear',

  // ── Staging ──────────────────────────────────────────────────────────────
  stagingList:    'staging list',
  stagingApprove: 'staging approve',
  stagingReject:  'staging reject',

  // ── Quarantine ───────────────────────────────────────────────────────────
  quarantineList:     'quarantine list',
  quarantineOverride: 'quarantine override',

  // ── Scrape ───────────────────────────────────────────────────────────────
  scrapeStart:   'scrape start',
  scrapeList:    'scrape list',
  scrapeStatus:  'scrape status',
  scrapeStop:    'scrape stop',
  scrapeResults: 'scrape results',

  // ── Ledger ───────────────────────────────────────────────────────────────
  ledgerList: 'ledger list',

  // ── HITL ─────────────────────────────────────────────────────────────────
  hitlList:    'hitl list',
  hitlApprove: 'hitl approve',
  hitlReject:  'hitl reject',
};
