/**
 * F.5.6 (ttv-finals): PgOntologyPackInstaller adapter.
 *
 * Resolves the tenant's bound domains (D.6 tenant_domain_binding, falling
 * back to D.1 tenant_domain_intake.classified_domain), pulls the matching
 * OntologyPack(s) from the registry, materialises each pack's entries as
 * LTM memories via an injected memory writer, and records the install in
 * oweibo.tenant_ontology_install.
 *
 * Idempotency: tenant_ontology_install ON CONFLICT (tenant_id,
 * domain_slug) DO UPDATE pack_version. A domain already at the current
 * pack_version is skipped — no entries re-written, alreadyCurrent grows.
 *
 * Memory write is INJECTED — the adapter is decoupled from the actual
 * vector store. Operators wire HttpMemoryWriter (F.5.9) or an
 * OrchestratorMemoryWriter; in tests the writer is a counting stub.
 */
import type { Pool, PoolClient } from 'pg';
import type { OntologyPackRegistry } from '../../domain/OntologyPackRegistry.js';
import type { OntologyPack } from '@oweibo/core-contracts';

export interface OntologyInstallReport {
  readonly consideredDomains: readonly string[];
  readonly installed: readonly { readonly domainSlug: string; readonly packVersion: string; readonly entryCount: number }[];
  readonly alreadyCurrent: readonly string[];
}

export interface OntologyMemorySeed {
  readonly kind: 'glossary' | 'named-entity' | 'terminology';
  readonly domainSlug: string;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly content: string;
  readonly seedId: string;
}

export interface IOntologyMemoryWriter {
  writeSeeds(tenantId: string, seeds: readonly OntologyMemorySeed[]): Promise<{ readonly inserted: number }>;
}

export class PgOntologyPackInstaller {
  constructor(
    private readonly pool: Pool,
    private readonly registry: OntologyPackRegistry,
    private readonly memoryWriter: IOntologyMemoryWriter,
  ) {}

  /** Look up bound domains, render pack entries as memory seeds, persist installs, skip already-current versions. */
  async install(tenantId: string): Promise<OntologyInstallReport> {
    const consideredDomains = await this.resolveDomains(tenantId);
    if (consideredDomains.length === 0) {
      return { consideredDomains: [], installed: [], alreadyCurrent: [] };
    }

    const current = await this.loadCurrentInstalls(tenantId, consideredDomains);
    const installed: { domainSlug: string; packVersion: string; entryCount: number }[] = [];
    const alreadyCurrent: string[] = [];

    for (const domainSlug of consideredDomains) {
      const pack = this.registry.get(domainSlug as never);
      if (!pack) continue; // No pack ships for this domain yet.
      const installedVersion = current.get(domainSlug);
      if (installedVersion === pack.packVersion) {
        alreadyCurrent.push(domainSlug);
        continue;
      }

      const seeds = renderSeeds(pack);
      await this.memoryWriter.writeSeeds(tenantId, seeds);
      await this.upsertInstall(tenantId, domainSlug, pack.packVersion, seeds.length);
      installed.push({ domainSlug, packVersion: pack.packVersion, entryCount: seeds.length });
    }

    return { consideredDomains, installed, alreadyCurrent };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async resolveDomains(tenantId: string): Promise<string[]> {
    return this.tx(tenantId, async (client) => {
      // Prefer D.6 multi-binding rows.
      const bound = await client.query<{ domain_slug: string }>(
        `SELECT domain_slug FROM oweibo.tenant_domain_binding
          WHERE tenant_id = $1::uuid
          ORDER BY (role = 'primary') DESC, weight DESC`,
        [tenantId],
      );
      if (bound.rows.length > 0) {
        return bound.rows.map((r) => r.domain_slug);
      }
      // Fall back to D.1 single-domain intake.
      const intake = await client.query<{ classified_domain: string | null }>(
        `SELECT classified_domain FROM oweibo.tenant_domain_intake
          WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const slug = intake.rows[0]?.classified_domain;
      return slug ? [slug] : [];
    });
  }

  private async loadCurrentInstalls(tenantId: string, domains: readonly string[]): Promise<Map<string, string>> {
    if (domains.length === 0) return new Map();
    return this.tx(tenantId, async (client) => {
      const r = await client.query<{ domain_slug: string; pack_version: string }>(
        `SELECT domain_slug, pack_version
           FROM oweibo.tenant_ontology_install
          WHERE tenant_id = $1::uuid
            AND domain_slug = ANY($2::text[])
            AND retired_at IS NULL`,
        [tenantId, domains],
      );
      return new Map(r.rows.map((row) => [row.domain_slug, row.pack_version]));
    });
  }

  private async upsertInstall(
    tenantId: string,
    domainSlug: string,
    packVersion: string,
    entryCount: number,
  ): Promise<void> {
    await this.tx(tenantId, async (client) => {
      await client.query(
        `INSERT INTO oweibo.tenant_ontology_install
            (tenant_id, domain_slug, pack_version, entry_count, installed_at)
          VALUES ($1::uuid, $2, $3, $4, NOW())
          ON CONFLICT (tenant_id, domain_slug) DO UPDATE
            SET pack_version = EXCLUDED.pack_version,
                entry_count  = EXCLUDED.entry_count,
                installed_at = NOW(),
                retired_at   = NULL`,
        [tenantId, domainSlug, packVersion, entryCount],
      );
    });
  }

  private async tx<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (/^[0-9a-f-]{36}$/i.test(tenantId)) {
        await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
      }
      await client.query(`SET LOCAL ROLE platform_admin`).catch(() => undefined);
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

// ── Pack-to-seed rendering (pure) ────────────────────────────────────────

export function renderSeeds(pack: OntologyPack): readonly OntologyMemorySeed[] {
  const seeds: OntologyMemorySeed[] = [];

  for (const g of pack.glossary) {
    seeds.push({
      kind: 'glossary',
      domainSlug: pack.domainSlug,
      importance: 0.7,
      tags: [`domain:${pack.domainSlug}:glossary`, `domain:${pack.domainSlug}:ontology`, `seed:ontology:${pack.domainSlug}`],
      content: `${g.term}: ${g.definition}${g.aliases.length > 0 ? ` (aliases: ${g.aliases.join(', ')})` : ''}`,
      seedId: `${pack.domainSlug}:glossary:${g.term}`,
    });
  }
  for (const e of pack.namedEntities) {
    seeds.push({
      kind: 'named-entity',
      domainSlug: pack.domainSlug,
      importance: 0.65,
      tags: [`domain:${pack.domainSlug}:named-entity`, `domain:${pack.domainSlug}:ontology`, `seed:ontology:${pack.domainSlug}`],
      content: `${e.canonicalName} (${e.entityType}): ${e.description}`,
      seedId: `${pack.domainSlug}:entity:${e.canonicalName}`,
    });
  }
  for (const t of pack.terminology) {
    seeds.push({
      kind: 'terminology',
      domainSlug: pack.domainSlug,
      importance: 0.75,
      tags: [`domain:${pack.domainSlug}:terminology`, `domain:${pack.domainSlug}:ontology`, `seed:ontology:${pack.domainSlug}`],
      content: `${t.preferred} (avoid: ${t.deprecated.join(', ')}) — ${t.reason}`,
      seedId: `${pack.domainSlug}:term:${t.preferred}`,
    });
  }
  return seeds;
}
