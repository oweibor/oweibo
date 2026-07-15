/**
 * K.9 / arch §19 DR — backup-class taxonomy + restore-drill logic.
 *
 * §19's recovery table splits every fabric store into two classes:
 *
 *   - RE-DERIVABLE (search index, embeddings, knowledge graph, ACL cache):
 *     rebuilt by re-crawl from sources; no backup required BEYOND checkpoint
 *     metadata. Sources are truth, so RPO is effectively zero.
 *   - MUST-BACKUP (audit, policy, connector config, credentials, identity
 *     mappings, revision checkpoints): PITR backups; audit additionally
 *     append-only.
 *
 * The load-bearing subtlety, stated by §19 and enforced here: "re-derivability
 * is only real if crawl checkpoints are in the must-backup class — losing them
 * forces a full re-crawl rather than a delta resume, turning an hours-scale RTO
 * into days." So `kf_revision_vectors` and job checkpoints are MUST-BACKUP even
 * though they describe re-derivable data: they are what makes the re-derivation
 * a DELTA resume rather than a cold crawl.
 */

export type BackupClass = 're_derivable' | 'must_backup';

/**
 * Every fabric store's backup class. This is the DR registry the restore drill
 * consults; adding a store without classifying it should be caught by the
 * exhaustiveness check in the conformance test.
 */
export const STORE_BACKUP_CLASS: Readonly<Record<string, BackupClass>> = {
  // Re-derivable — rebuilt by re-crawl from sources.
  kf_knowledge_objects: 're_derivable',   // the search index
  kf_chunks: 're_derivable',              // embedding spans (vectors live in Qdrant, also re-derivable)
  kf_acl_snapshots: 're_derivable',       // ACL cache — re-fetched from source AclPort
  kf_membership_records: 're_derivable',  // re-crawled from the IdP PrincipalsPort
  kf_graph_edges: 're_derivable',         // knowledge graph — re-derived from crawled content

  // Must-backup — no source of truth to re-derive from.
  kf_tenant_policies: 'must_backup',      // policy store
  tenant_connectors: 'must_backup',       // connector config
  kf_canonical_identities: 'must_backup', // identity mappings (admin-confirmed merges are not re-derivable)
  kf_identity_links: 'must_backup',       // identity mappings
  kf_provenance: 'must_backup',           // audit-adjacent lineage
  kf_connector_deployments: 'must_backup',// rollout state
  // The checkpoints that make re-derivation a DELTA resume, not a cold crawl.
  kf_revision_vectors: 'must_backup',
  kf_jobs: 'must_backup',                 // carries checkpoint JSONB (delta resume points)
  kf_leases: 'must_backup',               // fencing tokens (INV-8) must survive restore
};

export function backupClassOf(store: string): BackupClass | undefined {
  return STORE_BACKUP_CLASS[store];
}

export function storesByClass(cls: BackupClass): readonly string[] {
  return Object.entries(STORE_BACKUP_CLASS).filter(([, c]) => c === cls).map(([s]) => s);
}

// ── Restore drill ─────────────────────────────────────────────────────────

export type ResumeMode = 'delta_resume' | 'full_recrawl';

export interface RestorePlan {
  /** Stores restored from PITR backup. */
  readonly restoreFromBackup: readonly string[];
  /** Stores rebuilt by re-crawl (not restored). */
  readonly rebuildByRecrawl: readonly string[];
  /** Whether re-crawl can delta-resume (checkpoints intact) or must cold-crawl. */
  readonly resumeMode: ResumeMode;
}

/**
 * Plan a per-tenant restore. Must-backup stores are restored from backup;
 * re-derivable stores are rebuilt by re-crawl. The resume mode is DELTA iff the
 * checkpoint stores (which are must-backup) were actually present in the
 * backup — the drill's whole point is to prove that they were, so a restore is
 * hours (delta) not days (full).
 */
export function planRestore(availableBackupStores: readonly string[]): RestorePlan {
  const backup = new Set(availableBackupStores);
  const mustBackup = storesByClass('must_backup');
  const reDerivable = storesByClass('re_derivable');

  // Checkpoints are the must-backup stores that make re-crawl a delta resume.
  const checkpointStores = ['kf_revision_vectors', 'kf_jobs'];
  const checkpointsIntact = checkpointStores.every((s) => backup.has(s));

  return {
    restoreFromBackup: mustBackup.filter((s) => backup.has(s)),
    rebuildByRecrawl: [...reDerivable],
    resumeMode: checkpointsIntact ? 'delta_resume' : 'full_recrawl',
  };
}

/**
 * A restore is COMPLETE only if every must-backup store was in the backup set.
 * A missing must-backup store is unrecoverable (there is no source to
 * re-derive it from) — so the drill fails loudly rather than silently losing,
 * say, the policy store or an admin-confirmed identity merge.
 */
export function restoreIsComplete(availableBackupStores: readonly string[]): { ok: boolean; missing: readonly string[] } {
  const backup = new Set(availableBackupStores);
  const missing = storesByClass('must_backup').filter((s) => !backup.has(s));
  return { ok: missing.length === 0, missing };
}
