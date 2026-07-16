/**
 * K.8 — IdentityResolutionService (arch §9, ADR-002): maps source principals
 * to canonical person records, probabilistically. Sole writer (INV-16) of
 * kf_canonical_identities + kf_identity_links (a Knowledge-Runtime component).
 *
 * Identity feeds RANKING, the cache key, and hedging — NEVER a permission
 * decision (§3.7). Confidence is the strongest signal (§3.2), the state gates
 * a single auto-merge bar (§3.3), Provisional is hedged and never blocks
 * (§3.4), and a rejected merge retracts edges ASYNC via GraphInvalidated
 * (§3.5) — never a synchronous graph mutation.
 */

import type { Pool, PoolClient } from 'pg';
import {
  scoreIdentity,
  identityState,
  type IdentitySignal,
  type IdentityState,
} from './identityScoring.js';

export interface LinkPrincipalInput {
  readonly tenantId: string;
  readonly source: string;
  readonly sourcePrincipalRef: string;
  readonly signals: readonly IdentitySignal[];
  /** Canonical person hints; used when creating/matching the canonical identity. */
  readonly primaryEmail?: string;
  readonly displayName?: string;
  /** Force this canonical identity (e.g. an operator confirm); else matched by email. */
  readonly canonicalId?: string;
}

export interface LinkResult {
  readonly canonicalId: string | null; // null when Unresolved (no cross-source link)
  readonly confidence: number;
  readonly state: IdentityState;
  readonly linkId: string | null;
}

export interface CanonicalResolution {
  readonly canonicalId: string;
  readonly state: IdentityState;
  readonly confidence: number;
}

export class IdentityResolutionService {
  constructor(private readonly pool: Pool) {}

  /**
   * Resolve one source principal. Scores the signals; Resolved auto-merges
   * into (or creates) a canonical identity; Provisional writes a provisional
   * link (never auto-merges, but is tentatively associated); Unresolved
   * writes NO cross-source link.
   */
  async linkPrincipal(input: LinkPrincipalInput): Promise<LinkResult> {
    const confidence = scoreIdentity(input.signals);
    const state = identityState(confidence);

    if (state === 'unresolved') {
      return { canonicalId: null, confidence, state, linkId: null };
    }

    return this.withTenant(input.tenantId, async (c) => {
      // Find or create the canonical identity (by explicit id, else by email).
      let canonicalId = input.canonicalId ?? null;
      if (!canonicalId && input.primaryEmail) {
        const found = await c.query<{ id: string }>(
          `SELECT id FROM oweibo.kf_canonical_identities
            WHERE tenant_id = $1::uuid AND primary_email = $2 LIMIT 1`,
          [input.tenantId, input.primaryEmail],
        );
        canonicalId = found.rows[0]?.id ?? null;
      }
      if (!canonicalId) {
        const created = await c.query<{ id: string }>(
          `INSERT INTO oweibo.kf_canonical_identities (tenant_id, primary_email, display_name)
           VALUES ($1::uuid, $2, $3) RETURNING id`,
          [input.tenantId, input.primaryEmail ?? null, input.displayName ?? null],
        );
        canonicalId = created.rows[0]!.id;
      }

      const link = await c.query<{ id: string }>(
        `INSERT INTO oweibo.kf_identity_links
           (tenant_id, canonical_id, source, source_principal_ref, confidence, state, signals)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, source, source_principal_ref)
         DO UPDATE SET canonical_id = EXCLUDED.canonical_id, confidence = EXCLUDED.confidence,
                       state = EXCLUDED.state, signals = EXCLUDED.signals, updated_at = NOW()
         RETURNING id`,
        [input.tenantId, canonicalId, input.source, input.sourcePrincipalRef, confidence, state, JSON.stringify(input.signals)],
      );
      return { canonicalId, confidence, state, linkId: link.rows[0]!.id };
    });
  }

  /**
   * §9.4 bootstrap: reconcile against the IdP directory (kf_principal_seeds).
   * Principals sharing a verified_email are the same person (corporate_email
   * signal 0.98 → Resolved) — one canonical identity per email, resolved
   * links for each source principal. Returns the count of canonical identities.
   */
  async bootstrapFromSeeds(tenantId: string): Promise<{ canonicalIdentities: number; links: number }> {
    const seeds = await this.withTenant(tenantId, (c) =>
      c.query<{ source: string; principal_ref: string; verified_email: string; display_name: string | null }>(
        `SELECT source, principal_ref, verified_email, display_name
           FROM oweibo.kf_principal_seeds
          WHERE tenant_id = $1::uuid AND verified_email IS NOT NULL`,
        [tenantId],
      ).then((r) => r.rows),
    );

    let links = 0;
    const emails = new Set<string>();
    for (const seed of seeds) {
      const res = await this.linkPrincipal({
        tenantId, source: seed.source, sourcePrincipalRef: seed.principal_ref,
        signals: ['corporate_email'], primaryEmail: seed.verified_email,
        ...(seed.display_name ? { displayName: seed.display_name } : {}),
      });
      if (res.linkId) links += 1;
      emails.add(seed.verified_email);
    }
    return { canonicalIdentities: emails.size, links };
  }

  /** Resolve a source principal to its canonical identity + state (for the cache key + hedging). */
  async canonicalFor(tenantId: string, source: string, principalRef: string): Promise<CanonicalResolution | null> {
    return this.withTenant(tenantId, async (c) => {
      const r = await c.query<{ canonical_id: string; state: IdentityState; confidence: string }>(
        `SELECT canonical_id, state, confidence FROM oweibo.kf_identity_links
          WHERE tenant_id = $1::uuid AND source = $2 AND source_principal_ref = $3
            AND state <> 'unresolved' LIMIT 1`,
        [tenantId, source, principalRef],
      );
      const row = r.rows[0];
      return row ? { canonicalId: row.canonical_id, state: row.state, confidence: Number(row.confidence) } : null;
    });
  }

  /** §9.3 review queue: provisional links awaiting human confirmation. */
  async reviewQueue(tenantId: string): Promise<Array<{ linkId: string; canonicalId: string; source: string; principalRef: string; confidence: number }>> {
    return this.withTenant(tenantId, (c) =>
      c.query<{ id: string; canonical_id: string; source: string; source_principal_ref: string; confidence: string }>(
        `SELECT id, canonical_id, source, source_principal_ref, confidence
           FROM oweibo.kf_identity_links
          WHERE tenant_id = $1::uuid AND state = 'provisional' ORDER BY confidence DESC`,
        [tenantId],
      ).then((r) => r.rows.map((x) => ({
        linkId: x.id, canonicalId: x.canonical_id, source: x.source,
        principalRef: x.source_principal_ref, confidence: Number(x.confidence),
      }))),
    );
  }

  /** Admin confirms a provisional merge → promote to Resolved + emit GraphUpdated. */
  async confirmMerge(tenantId: string, linkId: string): Promise<{ confirmed: boolean }> {
    return this.withTenant(tenantId, async (c) => {
      const r = await c.query<{ canonical_id: string }>(
        `UPDATE oweibo.kf_identity_links SET state = 'resolved', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'provisional'
          RETURNING canonical_id`,
        [tenantId, linkId],
      );
      if (r.rowCount === 0) return { confirmed: false };
      await c.query(
        `INSERT INTO oweibo.outbox (subject, payload) VALUES ('GraphUpdated', $1::jsonb)`,
        [JSON.stringify({ tenantId, canonical_id: r.rows[0]!.canonical_id, reason: 'merge_confirmed', timestamp: new Date().toISOString() })],
      );
      return { confirmed: true };
    });
  }

  /**
   * §3.5 admin rejects a provisional merge. NEVER a synchronous edge delete:
   * the link is marked unresolved and GraphInvalidated is emitted — the
   * Knowledge Graph retracts the affected edges asynchronously (§8.2, §9.3).
   */
  async rejectMerge(tenantId: string, linkId: string): Promise<{ rejected: boolean; canonicalId?: string }> {
    return this.withTenant(tenantId, async (c) => {
      const r = await c.query<{ canonical_id: string; source_principal_ref: string }>(
        `UPDATE oweibo.kf_identity_links SET state = 'unresolved', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'provisional'
          RETURNING canonical_id, source_principal_ref`,
        [tenantId, linkId],
      );
      if (r.rowCount === 0) return { rejected: false };
      const { canonical_id, source_principal_ref } = r.rows[0]!;
      await c.query(
        `INSERT INTO oweibo.outbox (subject, payload) VALUES ('GraphInvalidated', $1::jsonb)`,
        [JSON.stringify({
          tenantId, canonical_id, principal_ref: source_principal_ref,
          reason: 'merge_rejected', timestamp: new Date().toISOString(),
        })],
      );
      return { rejected: true, canonicalId: canonical_id };
    });
  }

  private async withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
