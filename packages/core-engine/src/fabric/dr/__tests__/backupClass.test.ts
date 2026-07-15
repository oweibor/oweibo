/**
 * K.9 / §19 — DR backup-class + restore-drill conformance.
 *
 * The load-bearing property (§19): re-derivability is only real if crawl
 * checkpoints are MUST-BACKUP. Losing them turns an hours-scale delta resume
 * into a days-scale full re-crawl — so the drill proves checkpoints survive.
 */
import {
  STORE_BACKUP_CLASS,
  backupClassOf,
  planRestore,
  restoreIsComplete,
  storesByClass,
} from '../backupClass';

describe('§19 — backup-class taxonomy', () => {
  it('the search index and graph are re-derivable (sources are truth)', () => {
    expect(backupClassOf('kf_knowledge_objects')).toBe('re_derivable');
    expect(backupClassOf('kf_graph_edges')).toBe('re_derivable');
    expect(backupClassOf('kf_acl_snapshots')).toBe('re_derivable');
  });

  it('policy, identity mappings, and config are must-backup (no source to re-derive)', () => {
    expect(backupClassOf('kf_tenant_policies')).toBe('must_backup');
    expect(backupClassOf('kf_canonical_identities')).toBe('must_backup');
    expect(backupClassOf('tenant_connectors')).toBe('must_backup');
  });

  it('CHECKPOINTS are must-backup even though they describe re-derivable data (§19)', () => {
    // This is the subtlety §19 calls out: checkpoints are what make re-derivation
    // a DELTA resume rather than a cold crawl.
    expect(backupClassOf('kf_revision_vectors')).toBe('must_backup');
    expect(backupClassOf('kf_jobs')).toBe('must_backup');
    expect(backupClassOf('kf_leases')).toBe('must_backup'); // fencing tokens (INV-8) survive restore
  });

  it('every classified store is one of the two classes', () => {
    for (const cls of Object.values(STORE_BACKUP_CLASS)) {
      expect(['re_derivable', 'must_backup']).toContain(cls);
    }
  });
});

describe('§19 — restore drill', () => {
  const allBackup = storesByClass('must_backup');

  it('a complete backup plans a DELTA resume (checkpoints intact → hours, not days)', () => {
    const plan = planRestore(allBackup);
    expect(plan.resumeMode).toBe('delta_resume');
    // Re-derivable stores are rebuilt by re-crawl, not restored.
    expect(plan.rebuildByRecrawl).toContain('kf_knowledge_objects');
    expect(plan.restoreFromBackup).toContain('kf_tenant_policies');
  });

  it('losing the checkpoint stores degrades resume to a FULL re-crawl (§19 warning)', () => {
    const withoutCheckpoints = allBackup.filter((s) => s !== 'kf_revision_vectors');
    expect(planRestore(withoutCheckpoints).resumeMode).toBe('full_recrawl');
  });

  it('a restore missing ANY must-backup store is incomplete (unrecoverable loss)', () => {
    const missingPolicy = allBackup.filter((s) => s !== 'kf_tenant_policies');
    const r = restoreIsComplete(missingPolicy);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('kf_tenant_policies');
  });

  it('a restore with every must-backup store is complete', () => {
    expect(restoreIsComplete(allBackup).ok).toBe(true);
  });

  it('re-derivable stores are NOT required in the backup for a complete restore', () => {
    // Only must-backup stores gate completeness; re-derivable ones are rebuilt.
    expect(restoreIsComplete(allBackup).ok).toBe(true); // allBackup has no re-derivable stores
  });
});
