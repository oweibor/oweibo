/**
 * S.5.a — ContentInspectorRegistry + inspector tests.
 *
 * Covers:
 *   - Registry: register / duplicate / names / matching filter
 *   - Combine semantics: forbid > upgrade_to_approval > allow
 *   - Per-inspector timeout → fail-closed (upgrade_to_approval)
 *   - Each inspector's positive and negative cases for the patterns
 *     they're supposed to flag.
 */
import type { ActionContext } from '@oweibo/core-contracts';
import { combineVerdicts } from '@oweibo/core-contracts';
import { ContentInspectorRegistry } from '../ContentInspectorRegistry.js';
import { SqlContentInspector } from '../inspectors/SqlContentInspector.js';
import { EmailContentInspector } from '../inspectors/EmailContentInspector.js';
import { DeploymentContentInspector } from '../inspectors/DeploymentContentInspector.js';
import { GitContentInspector } from '../inspectors/GitContentInspector.js';
import { FinancialContentInspector } from '../inspectors/FinancialContentInspector.js';
import { GenericPiiInspector } from '../inspectors/GenericPiiInspector.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

function makeCtx(actionClass: string, payload: unknown): ActionContext {
  return {
    tenantId: TENANT,
    userId: '22222222-2222-2222-2222-222222222222',
    actionClass: actionClass as ActionContext['actionClass'],
    actionId: 'a-1',
    summary: 's',
    payload,
    calibrationSnapshot: {
      tenantId: TENANT,
      accountAgeDays: 90,
      actionClassScores: {},
      snapshotAt: new Date().toISOString(),
      sourceSig: 'sig',
    },
  };
}

// ── combineVerdicts (pure) ───────────────────────────────────────────────

describe('combineVerdicts', () => {
  it('empty list → allow', () => {
    expect(combineVerdicts([])).toEqual({ verdict: 'allow' });
  });
  it('all allow → allow', () => {
    expect(combineVerdicts([{ verdict: 'allow' }, { verdict: 'allow' }])).toEqual({ verdict: 'allow' });
  });
  it('any upgrade → upgrade', () => {
    expect(combineVerdicts([{ verdict: 'allow' }, { verdict: 'upgrade_to_approval', reason: 'x' }])).toEqual({
      verdict: 'upgrade_to_approval', reason: 'x',
    });
  });
  it('any forbid wins', () => {
    expect(combineVerdicts([
      { verdict: 'upgrade_to_approval' },
      { verdict: 'forbid', reason: 'bad' },
      { verdict: 'allow' },
    ])).toEqual({ verdict: 'forbid', reason: 'bad' });
  });
});

// ── Registry ─────────────────────────────────────────────────────────────

describe('ContentInspectorRegistry', () => {
  it('register + names sorted', () => {
    const reg = new ContentInspectorRegistry();
    reg.register(new SqlContentInspector());
    reg.register(new GenericPiiInspector());
    expect(reg.names()).toEqual(['generic_pii', 'sql_content']);
  });

  it('refuses duplicates', () => {
    const reg = new ContentInspectorRegistry();
    reg.register(new SqlContentInspector());
    expect(() => reg.register(new SqlContentInspector())).toThrow(/duplicate/);
  });

  it('runs only matching inspectors', async () => {
    const reg = new ContentInspectorRegistry();
    reg.register(new SqlContentInspector());
    reg.register(new GenericPiiInspector());
    // GenericPii doesn't apply to write.tenant_db.prod
    const ctx = makeCtx('write.tenant_db.prod', { sql: 'SELECT 1' });
    const result = await reg.run(ctx);
    expect(result.perInspector.map((p) => p.inspectorName)).toEqual(['sql_content']);
    expect(result.combined.verdict).toBe('allow');
  });

  it('empty match → allow with empty list', async () => {
    const reg = new ContentInspectorRegistry();
    reg.register(new SqlContentInspector());
    const result = await reg.run(makeCtx('read.local', {}));
    expect(result.combined.verdict).toBe('allow');
    expect(result.perInspector).toEqual([]);
  });

  it('inspector timeout → fail-closed upgrade_to_approval', async () => {
    const reg = new ContentInspectorRegistry();
    reg.register({
      name: 'slow',
      appliesTo: () => true,
      inspect: () => new Promise(() => {}), // never resolves
    });
    const result = await reg.run(makeCtx('read.local', {}));
    expect(result.combined.verdict).toBe('upgrade_to_approval');
    expect(result.perInspector[0]!.result.reason).toMatch(/timeout/);
  }, 2_000);

  it('inspector throws → fail-closed upgrade_to_approval', async () => {
    const reg = new ContentInspectorRegistry();
    reg.register({
      name: 'broken',
      appliesTo: () => true,
      inspect: () => { throw new Error('boom'); },
    });
    const result = await reg.run(makeCtx('read.local', {}));
    expect(result.combined.verdict).toBe('upgrade_to_approval');
    expect(result.perInspector[0]!.result.reason).toMatch(/boom/);
  });
});

// ── SqlContentInspector ──────────────────────────────────────────────────

describe('SqlContentInspector', () => {
  const insp = new SqlContentInspector();

  it('appliesTo write.tenant_db.* only', () => {
    expect(insp.appliesTo('write.tenant_db.prod')).toBe(true);
    expect(insp.appliesTo('write.tenant_db.nonprod')).toBe(true);
    expect(insp.appliesTo('read.tenant_db')).toBe(false);
    expect(insp.appliesTo('write.local.scratch')).toBe(false);
  });

  it('allows safe SELECT', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: 'SELECT * FROM users WHERE id = 1' }));
    expect(r.verdict).toBe('allow');
  });

  it('forbids DROP TABLE', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: 'DROP TABLE users' }));
    expect(r.verdict).toBe('forbid');
  });

  it('forbids TRUNCATE', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: 'TRUNCATE TABLE users' }));
    expect(r.verdict).toBe('forbid');
  });

  it('forbids DELETE without WHERE', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: 'DELETE FROM users' }));
    expect(r.verdict).toBe('forbid');
  });

  it('forbids DELETE with WHERE 1=1', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: 'DELETE FROM users WHERE 1=1' }));
    expect(r.verdict).toBe('forbid');
  });

  it('allows DELETE with real WHERE', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: "DELETE FROM users WHERE id = 5" }));
    expect(r.verdict).toBe('allow');
  });

  it('forbids UPDATE without WHERE', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: "UPDATE users SET name='x'" }));
    expect(r.verdict).toBe('forbid');
  });

  it('upgrades ALTER TABLE DROP COLUMN', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: 'ALTER TABLE users DROP COLUMN name' }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });

  it('upgrades GRANT', async () => {
    const r = await insp.inspect(makeCtx('write.tenant_db.prod', { sql: 'GRANT ALL ON users TO bob' }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });
});

// ── EmailContentInspector ────────────────────────────────────────────────

describe('EmailContentInspector', () => {
  const insp = new EmailContentInspector();

  it('appliesTo comm.external_email only', () => {
    expect(insp.appliesTo('comm.external_email')).toBe(true);
    expect(insp.appliesTo('comm.internal')).toBe(false);
  });

  it('allows ordinary mail', async () => {
    const r = await insp.inspect(makeCtx('comm.external_email', {
      to: ['alice@example.com'], body: 'hello',
    }));
    expect(r.verdict).toBe('allow');
  });

  it('forbids body with AWS access key id', async () => {
    const r = await insp.inspect(makeCtx('comm.external_email', {
      to: ['alice@example.com'], body: 'key AKIAIOSFODNN7EXAMPLE leaked',
    }));
    expect(r.verdict).toBe('forbid');
  });

  it('upgrades on external recipient with internal tag', async () => {
    const r = await insp.inspect(makeCtx('comm.external_email', {
      to: ['external@other.com'], body: 'hi',
      threadTags: ['internal'], senderDomain: 'us.com',
    }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });

  it('forbids on too many attachments', async () => {
    const atts = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, sizeBytes: 100 }));
    const r = await insp.inspect(makeCtx('comm.external_email', {
      to: ['a@b.com'], body: 'x', attachments: atts,
    }));
    expect(r.verdict).toBe('forbid');
  });

  it('upgrades on recipient blast', async () => {
    const to = Array.from({ length: 60 }, (_, i) => `u${i}@example.com`);
    const r = await insp.inspect(makeCtx('comm.external_email', { to, body: 'x' }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });
});

// ── DeploymentContentInspector ───────────────────────────────────────────

describe('DeploymentContentInspector', () => {
  it('forbids missing artifactHash', async () => {
    const insp = new DeploymentContentInspector();
    const r = await insp.inspect(makeCtx('deploy.prod', {}));
    expect(r.verdict).toBe('forbid');
  });

  it('upgrades when no registry wired', async () => {
    const insp = new DeploymentContentInspector();
    const r = await insp.inspect(makeCtx('deploy.prod', { artifactHash: 'abc' }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });

  it('forbids hash not in registry', async () => {
    const insp = new DeploymentContentInspector({
      isApproved: async () => false,
    });
    const r = await insp.inspect(makeCtx('deploy.prod', { artifactHash: 'unknown' }));
    expect(r.verdict).toBe('forbid');
  });

  it('allows hash present in registry', async () => {
    const insp = new DeploymentContentInspector({
      isApproved: async () => true,
    });
    const r = await insp.inspect(makeCtx('deploy.prod', { artifactHash: 'sha256-abc' }));
    expect(r.verdict).toBe('allow');
  });

  it('forbids env mismatch', async () => {
    const insp = new DeploymentContentInspector({ isApproved: async () => true });
    const r = await insp.inspect(makeCtx('deploy.prod', { artifactHash: 'h', env: 'staging' }));
    expect(r.verdict).toBe('forbid');
  });
});

// ── GitContentInspector ──────────────────────────────────────────────────

describe('GitContentInspector', () => {
  const insp = new GitContentInspector();

  it('forbids force-push to main', async () => {
    const r = await insp.inspect(makeCtx('write.local.repo_prod', {
      command: 'git push --force origin main', branch: 'main',
    }));
    expect(r.verdict).toBe('forbid');
  });

  it('forbids branch delete of main', async () => {
    const r = await insp.inspect(makeCtx('write.local.repo_prod', {
      command: 'git push origin --delete', branch: 'main',
    }));
    expect(r.verdict).toBe('forbid');
  });

  it('forbids touching protected paths', async () => {
    const r = await insp.inspect(makeCtx('write.local.repo_prod', {
      command: 'git commit -m fix', branch: 'feature/foo',
      changedPaths: ['packages/db/migrations/000999_evil.sql'],
    }));
    expect(r.verdict).toBe('forbid');
  });

  it('allows non-protected feature branch commit', async () => {
    const r = await insp.inspect(makeCtx('write.local.repo_prod', {
      command: 'git commit -m fix', branch: 'feature/foo',
      changedPaths: ['src/foo.ts'],
    }));
    expect(r.verdict).toBe('allow');
  });

  it('upgrades rebase on protected branch', async () => {
    const r = await insp.inspect(makeCtx('write.local.repo_prod', {
      command: 'git rebase origin/main', branch: 'main',
    }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });
});

// ── FinancialContentInspector ────────────────────────────────────────────

describe('FinancialContentInspector', () => {
  it('forbids missing amount', async () => {
    const insp = new FinancialContentInspector();
    const r = await insp.inspect(makeCtx('financial.payment', { currency: 'USD' }));
    expect(r.verdict).toBe('forbid');
  });

  it('forbids non-ISO currency', async () => {
    const insp = new FinancialContentInspector();
    const r = await insp.inspect(makeCtx('financial.payment', { amountCents: 100, currency: 'us$' }));
    expect(r.verdict).toBe('forbid');
  });

  it('forbids over default cap', async () => {
    const insp = new FinancialContentInspector();
    const r = await insp.inspect(makeCtx('financial.payment', { amountCents: 10_000_000, currency: 'USD' }));
    expect(r.verdict).toBe('forbid');
  });

  it('allows under cap with no resolver', async () => {
    const insp = new FinancialContentInspector();
    const r = await insp.inspect(makeCtx('financial.payment', { amountCents: 100, currency: 'USD' }));
    expect(r.verdict).toBe('allow');
  });

  it('upgrades on unknown recipient', async () => {
    const insp = new FinancialContentInspector({
      absoluteCapCents: async () => 100_000_00,
      isKnownRecipient: async () => false,
    });
    const r = await insp.inspect(makeCtx('financial.payment', {
      amountCents: 500, currency: 'USD', recipient: { id: 'r-1' },
    }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });

  it('upgrades on amount spike', async () => {
    const insp = new FinancialContentInspector({
      absoluteCapCents: async () => 100_000_00,
      historicalAvgCents: async () => 10_000, // $100 avg
    });
    const r = await insp.inspect(makeCtx('financial.payment', {
      amountCents: 100_000, currency: 'USD', // $1000, 10x avg
    }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });
});

// ── GenericPiiInspector ──────────────────────────────────────────────────

describe('GenericPiiInspector', () => {
  const insp = new GenericPiiInspector();

  it('appliesTo external classes', () => {
    expect(insp.appliesTo('comm.external_email')).toBe(true);
    expect(insp.appliesTo('write.external_api.prod')).toBe(true);
    expect(insp.appliesTo('read.local')).toBe(false);
  });

  it('forbids Luhn-valid CC', async () => {
    // 4111 1111 1111 1111 is a known Luhn-valid test PAN.
    const r = await insp.inspect(makeCtx('comm.external_email', {
      body: 'card 4111 1111 1111 1111 attached',
    }));
    expect(r.verdict).toBe('forbid');
  });

  it('allows random digits that fail Luhn', async () => {
    const r = await insp.inspect(makeCtx('comm.external_email', {
      body: 'order 1234567890123456',
    }));
    expect(r.verdict).toBe('allow');
  });

  it('upgrades on SSN', async () => {
    const r = await insp.inspect(makeCtx('comm.external_email', {
      body: 'SSN 123-45-6789',
    }));
    expect(r.verdict).toBe('upgrade_to_approval');
  });
});
