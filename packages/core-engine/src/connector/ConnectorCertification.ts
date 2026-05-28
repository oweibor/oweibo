/**
 * D.4 (domain-depth): ConnectorCertification — read/write surface over
 * `oweibo.connector_certifications`.
 *
 * Write path: the CI cert runner POSTs a `recordCertification(...)` call
 * after `runCertificationSuite()` returns `passed: true`. Failures are
 * NOT recorded — only passing certifications go in the ledger so the
 * read side never accidentally surfaces a partial pass.
 *
 * Read path: the admin UI lists the highest-tier certification per
 * connector; the bootstrap recommendation path consults
 * `lookupCertification(connectorId, catalogVersion)` to filter
 * recommendations when the tenant's policy demands tier ≥ verified.
 *
 * The certifier role is restricted to platform_admin per the migration's
 * platform_admin_write policy.
 */
import type { Pool } from 'pg';
import type { CertificationTier } from '@oweibo/core-contracts';

export interface CertificationRecord {
  readonly connectorId: string;
  readonly catalogVersion: string;
  readonly certificationTier: CertificationTier;
  readonly certifiedFor: readonly string[];
  readonly testSuiteHash: string;
  readonly passedAt: string;
  readonly expiresAt: string | null;
  readonly certifier: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RecordCertificationInput {
  readonly connectorId: string;
  readonly catalogVersion: string;
  readonly certificationTier: CertificationTier;
  readonly certifiedFor: readonly string[];
  readonly testSuiteHash: string;
  /** 'ci' | 'platform_admin:<user>'. */
  readonly certifier: string;
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ConnectorCertificationOptions {
  /** Default: a function that returns 'platform_admin'. */
  setLocalRole?: () => string;
  /** Clock for test injection. */
  now?: () => Date;
}

export class ConnectorCertification {
  private readonly roleName: () => string;
  private readonly now: () => Date;

  constructor(private readonly pool: Pool, opts: ConnectorCertificationOptions = {}) {
    this.roleName = opts.setLocalRole ?? (() => 'platform_admin');
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Insert (or refresh) a certification record. Idempotent on
   * (connectorId, catalog_version) via ON CONFLICT — re-running the
   * cert suite with the same hash UPDATEs `passed_at` and `certifier`
   * but preserves the original `expires_at` if not supplied.
   */
  async recordCertification(input: RecordCertificationInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${this.roleName()}`).catch(() => undefined);
      await client.query(
        `INSERT INTO oweibo.connector_certifications
           (connector_id, catalog_version, certification_tier, certified_for,
            test_suite_hash, passed_at, expires_at, certifier, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (connector_id, catalog_version) DO UPDATE
           SET certification_tier = EXCLUDED.certification_tier,
               certified_for      = EXCLUDED.certified_for,
               test_suite_hash    = EXCLUDED.test_suite_hash,
               passed_at          = EXCLUDED.passed_at,
               expires_at         = COALESCE(EXCLUDED.expires_at, oweibo.connector_certifications.expires_at),
               certifier          = EXCLUDED.certifier,
               metadata           = EXCLUDED.metadata`,
        [
          input.connectorId,
          input.catalogVersion,
          input.certificationTier,
          input.certifiedFor,
          input.testSuiteHash,
          this.now(),
          input.expiresAt ?? null,
          input.certifier,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async lookupCertification(
    connectorId: string,
    catalogVersion: string,
  ): Promise<CertificationRecord | null> {
    const client = await this.pool.connect();
    try {
      const r = await client.query<{
        connector_id: string;
        catalog_version: string;
        certification_tier: CertificationTier;
        certified_for: string[];
        test_suite_hash: string;
        passed_at: Date | string;
        expires_at: Date | string | null;
        certifier: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT connector_id, catalog_version, certification_tier, certified_for,
                test_suite_hash, passed_at, expires_at, certifier, metadata
           FROM oweibo.connector_certifications
          WHERE connector_id = $1 AND catalog_version = $2`,
        [connectorId, catalogVersion],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        connectorId: row.connector_id,
        catalogVersion: row.catalog_version,
        certificationTier: row.certification_tier,
        certifiedFor: row.certified_for ?? [],
        testSuiteHash: row.test_suite_hash,
        passedAt: row.passed_at instanceof Date ? row.passed_at.toISOString() : String(row.passed_at),
        expiresAt:
          row.expires_at === null
            ? null
            : row.expires_at instanceof Date
              ? row.expires_at.toISOString()
              : String(row.expires_at),
        certifier: row.certifier,
        metadata: row.metadata ?? {},
      };
    } finally {
      client.release();
    }
  }

  /**
   * All current certifications for a connector across its catalog
   * versions. Useful for the admin UI's "Show certification history".
   */
  async listForConnector(connectorId: string): Promise<readonly CertificationRecord[]> {
    const client = await this.pool.connect();
    try {
      const r = await client.query<{
        connector_id: string;
        catalog_version: string;
        certification_tier: CertificationTier;
        certified_for: string[];
        test_suite_hash: string;
        passed_at: Date | string;
        expires_at: Date | string | null;
        certifier: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT connector_id, catalog_version, certification_tier, certified_for,
                test_suite_hash, passed_at, expires_at, certifier, metadata
           FROM oweibo.connector_certifications
          WHERE connector_id = $1
          ORDER BY passed_at DESC`,
        [connectorId],
      );
      return r.rows.map((row) => ({
        connectorId: row.connector_id,
        catalogVersion: row.catalog_version,
        certificationTier: row.certification_tier,
        certifiedFor: row.certified_for ?? [],
        testSuiteHash: row.test_suite_hash,
        passedAt: row.passed_at instanceof Date ? row.passed_at.toISOString() : String(row.passed_at),
        expiresAt:
          row.expires_at === null
            ? null
            : row.expires_at instanceof Date
              ? row.expires_at.toISOString()
              : String(row.expires_at),
        certifier: row.certifier,
        metadata: row.metadata ?? {},
      }));
    } finally {
      client.release();
    }
  }
}
