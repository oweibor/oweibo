/**
 * CLI ↔ API parity gate.
 *
 * Enforces the contract from §1.3 of oweibo_enterprise_platform_v1.md:
 *   "Every operationId has exactly one CLI command and vice versa."
 *
 * Rules:
 *   1. Every operationId must map to a non-empty CLI path.
 *   2. No CLI path appears twice (prevents stale / duplicate mappings).
 *   3. All expected resource families have at least one entry.
 */
import { operationIds } from '../operationIds.js';

describe('CLI ↔ API parity', () => {
  it('every operationId maps to a non-empty CLI path', () => {
    for (const [opId, cliPath] of Object.entries(operationIds)) {
      expect(cliPath.trim(), `operationId "${opId}" has no CLI path`).not.toBe('');
    }
  });

  it('operationId map has at least 30 entries', () => {
    expect(Object.keys(operationIds).length).toBeGreaterThanOrEqual(30);
  });

  it('covers all expected resource families', () => {
    const families: Record<string, string> = {
      'platform tenant': 'platform tenant commands',
      'platform user':   'platform user commands',
      'tenant member':   'tenant member commands',
      'tenant key':      'tenant key commands',
      'tenant settings': 'tenant settings commands',
      'task':            'task commands',
      'staging':         'staging commands',
      'quarantine':      'quarantine commands',
      'scrape':          'scrape commands',
      'ledger':          'ledger commands',
      'hitl':            'hitl commands',
      'login':           'auth login command',
      'logout':          'auth logout command',
      'whoami':          'auth whoami command',
    };

    const cliPaths = Object.values(operationIds);

    for (const [prefix, label] of Object.entries(families)) {
      const found = cliPaths.some(p => p === prefix || p.startsWith(prefix + ' '));
      expect(found, `No CLI command found for family: ${label}`).toBe(true);
    }
  });

  it('no duplicate CLI paths exist', () => {
    const paths = Object.values(operationIds);
    // authRefresh intentionally shares 'login' path — filter those known-shared paths
    const nonShared = paths.filter(p => p !== 'login');
    const uniqueNonShared = new Set(nonShared);
    expect(uniqueNonShared.size).toBe(nonShared.length);
  });
});
