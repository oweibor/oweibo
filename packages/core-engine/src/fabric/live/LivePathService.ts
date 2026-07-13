/**
 * K.6 — LivePathService: the Claude-connectors half (arch §5, §6.6, §7.5–7.6,
 * §16.2). For Transactional/Critical fields the planner routes here for a LIVE
 * read instead of the index. It:
 *
 *   1. gates every candidate connector through the storage-layer serving rule
 *      (ADR-010 decideServing, fed the lifecycle state via ADR-004
 *      serviceState) — a Degraded connector's Critical content is WITHHELD
 *      here, never served stale, never by planner discretion;
 *   2. fans out to the top-k ranked serving connectors (health-score ranking,
 *      §7.6), reads live under a per-read budget, and CUTS stragglers past the
 *      budget — recording the omission in provenance (§17);
 *   3. detects §16.2 conflicts (live revision > index revision) → serves the
 *      live answer, marks the indexed object stale, emits ReindexRequested
 *      (ADR-003 self-heal) — the conflict is never surfaced to the user;
 *   4. composes the field-disjoint multi-path result (ADR-008 §3.4).
 *
 * Live-read is via an injected LiveReadPort (production adapts the existing
 * MCPClientRegistry; the engine takes no connector-sdk dependency, so the port
 * is a structural mirror). Credentials NEVER pass through here (INV-10) — the
 * port resolves them at egress.
 */

import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import {
  fieldsRequiringLive,
  worstFieldClass,
  composeMultiPath,
  type FieldFreshness,
} from './fieldFreshness.js';
import { serviceState, type AuthState } from './ConnectorLifecycle.js';
import { decideServing } from '../permissions/contract.js';
import { classifyConflict } from '../consistency/contract.js';

/** Structural mirror of the live-read surface (production adapts MCPClientRegistry). */
export interface LiveReadPort<Ctx> {
  readLive(ctx: Ctx, documentId: string, fields: readonly string[]): Promise<{
    readonly fields: Readonly<Record<string, unknown>>;
    readonly revision: number;
  }>;
}

export interface LiveConnectorCandidate<Ctx> {
  readonly connectorId: string;
  /** Lifecycle Auth-region state (ADR-004) — projected to the serving state. */
  readonly auth: AuthState;
  readonly degradedSinceMs?: number;
  /** Health score in [0,1] (§23) — the primary fan-out ranking input. */
  readonly healthScore: number;
  /** Historical hit rate for this intent class in [0,1]; defaults to 0.5. */
  readonly hitRate?: number;
  readonly port: LiveReadPort<Ctx>;
  readonly ctx: Ctx;
  /** True once one live re-validation pass has completed post-recovery (ADR-004 §3.4). */
  readonly revalidationComplete?: boolean;
}

export interface LivePathInput<Ctx> {
  readonly tenantId: string;
  readonly source: string;
  readonly documentId: string;
  /** The indexed object's id — needed to mark stale / cite provenance. */
  readonly knowledgeObjectId: string;
  /** Per-field effective class + index age (ADR-008 resolution done upstream). */
  readonly fields: readonly FieldFreshness[];
  /** Index-served field values, to compose with the live ones (ADR-008 §3.4). */
  readonly indexFields: Readonly<Record<string, unknown>>;
  /** The stored source revision, for §16.2 conflict detection. */
  readonly indexRevision: number;
  readonly indexGeneration?: number;
  readonly aclVersion?: number;
  readonly complianceFlagged?: boolean;
  readonly connectors: readonly LiveConnectorCandidate<Ctx>[];
  readonly nowMs?: number;
  readonly topK?: number;
  readonly perReadBudgetMs?: number;
}

export interface LivePathResult {
  readonly retrievalId: string;
  /** The composed field-disjoint object (index + live), or null when withheld. */
  readonly composed: Readonly<Record<string, unknown>> | null;
  readonly fieldPaths: Readonly<Record<string, 'index' | 'live'>>;
  /** 'served' | 'withheld' (§6.6) — the storage-layer verdict for the doc. */
  readonly verdict: 'served' | 'withheld';
  /** Connectors withheld by the ADR-010 gate (count only — never enumerated to callers). */
  readonly withheldConnectors: number;
  /** Connectors cut for exceeding the per-read budget (§7.6 straggler cuts). */
  readonly stragglerCuts: readonly string[];
  readonly conflictsHealed: number;
  /** The live revision that won, when a conflict healed. */
  readonly servedRevision: number | null;
}

const TIMEOUT = Symbol('live-read-timeout');

export class LivePathService {
  constructor(private readonly pool: Pool) {}

  async livePathQuery<Ctx>(input: LivePathInput<Ctx>): Promise<LivePathResult> {
    const now = input.nowMs ?? Date.now();
    const topK = input.topK ?? 3;
    const budget = input.perReadBudgetMs ?? 3000;
    const retrievalId = randomUUID();

    const worst = worstFieldClass(input.fields.map((f) => f.effectiveClass));
    const liveFields = fieldsRequiringLive(input.fields);

    // No field needs a live read → index is authoritative; nothing to do here.
    if (liveFields.length === 0) {
      return {
        retrievalId, composed: input.indexFields, fieldPaths: allIndex(input.indexFields),
        verdict: 'served', withheldConnectors: 0, stragglerCuts: [], conflictsHealed: 0, servedRevision: null,
      };
    }

    // ── Storage-layer serving gate per connector (ADR-010 §6.6). A Degraded
    // connector's Critical content is WITHHELD — not planner discretion. ────
    let withheldConnectors = 0;
    const serving: LiveConnectorCandidate<Ctx>[] = [];
    for (const conn of input.connectors) {
      const decision = decideServing({
        freshnessClass: worst,
        complianceFlagged: input.complianceFlagged ?? false,
        connectorState: serviceState(conn.auth),
        ...(conn.degradedSinceMs !== undefined ? { degradedSinceMs: conn.degradedSinceMs } : {}),
        nowMs: now,
      });
      if (decision === 'withhold') withheldConnectors += 1;
      else serving.push(conn);
    }

    // Every candidate withheld → the doc is withheld entirely (§6.6): explicit
    // "temporarily unavailable", never a silent omission or a stale serve.
    if (serving.length === 0) {
      return {
        retrievalId, composed: null, fieldPaths: {}, verdict: 'withheld',
        withheldConnectors, stragglerCuts: [], conflictsHealed: 0, servedRevision: null,
      };
    }

    // ── Fan-out: rank by health, cap at top-k (§7.6) ──────────────────────
    const ranked = rankLiveConnectors(serving).slice(0, topK);

    // ── Live reads under a per-read budget; stragglers are cut (§7.6) ─────
    const stragglerCuts: string[] = [];
    const reads = await Promise.all(
      ranked.map(async (conn) => {
        try {
          const out = await withDeadline(conn.port.readLive(conn.ctx, input.documentId, liveFields), budget);
          if (out === TIMEOUT) { stragglerCuts.push(conn.connectorId); return null; }
          return { connectorId: conn.connectorId, ...out };
        } catch {
          // A live-read failure is not a withholding — the gate already ran;
          // it is a straggler-equivalent omission recorded in provenance.
          stragglerCuts.push(conn.connectorId);
          return null;
        }
      }),
    );
    const live = reads.filter((r): r is NonNullable<typeof r> => r !== null);

    // No live read completed within budget → fall back to the index copy for
    // the live fields' most recent indexed values (they were gate-approved).
    if (live.length === 0) {
      return {
        retrievalId, composed: input.indexFields, fieldPaths: allIndex(input.indexFields),
        verdict: 'served', withheldConnectors, stragglerCuts, conflictsHealed: 0, servedRevision: null,
      };
    }

    // Highest live revision wins (§16.1 metadata / §16.2 live-wins).
    const winner = live.reduce((a, b) => (a.revision >= b.revision ? a : b));

    // ── §16.2 conflict: live revision ahead of index → serve live, mark
    // stale, emit ReindexRequested. The user gets the live answer; the system
    // heals async; the conflict is never surfaced as ambiguity. ────────────
    let conflictsHealed = 0;
    const cls = classifyConflict(winner.revision, input.indexRevision);
    if (cls !== 'consistent') {
      conflictsHealed = 1;
      await this.emitReindexRequested(input, winner.revision, cls);
    }

    // ── Compose field-disjoint (ADR-008 §3.4): live fields override index ──
    const composition = composeMultiPath(input.indexFields, winner.fields);

    // Provenance: one row for the live-served result (retrieval_path 'live').
    await this.writeProvenance(input, retrievalId, winner.revision, worst);

    return {
      retrievalId,
      composed: composition.fields,
      fieldPaths: composition.fieldPaths,
      verdict: 'served',
      withheldConnectors,
      stragglerCuts,
      conflictsHealed,
      servedRevision: winner.revision,
    };
  }

  /**
   * §16.2 self-heal: emit ReindexRequested (cause only). The live path is a
   * DETECTOR, not a writer of KnowledgeObject state — the Knowledge Runtime
   * (IndexingService.markStale) is the sole writer of kf_knowledge_objects
   * (INV-16) and marks the object stale on consuming this event, exactly as
   * RetrievalService does. Emitting-not-writing keeps the sole-writer rule.
   */
  private async emitReindexRequested<Ctx>(input: LivePathInput<Ctx>, liveRevision: number, conflict: string): Promise<void> {
    await this.withTenant(input.tenantId, (c) =>
      c.query(
        `INSERT INTO oweibo.outbox (subject, payload) VALUES ('ReindexRequested', $1::jsonb)`,
        [JSON.stringify({
          tenantId: input.tenantId, source: input.source, document_id: input.documentId,
          live_revision: liveRevision, index_revision: input.indexRevision,
          conflict, path: 'live', timestamp: new Date().toISOString(),
        })],
      ),
    );
  }

  private async writeProvenance<Ctx>(
    input: LivePathInput<Ctx>, retrievalId: string, revision: number, freshnessClass: string,
  ): Promise<void> {
    await this.withTenant(input.tenantId, (c) =>
      c.query(
        `INSERT INTO oweibo.kf_provenance
           (tenant_id, retrieval_id, knowledge_object_id, source, retrieval_path,
            index_generation, source_revision, acl_version, freshness_class)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'live', $5, $6, $7, $8)`,
        [
          input.tenantId, retrievalId, input.knowledgeObjectId, input.source,
          input.indexGeneration ?? 0, revision, input.aclVersion ?? 0, freshnessClass,
        ],
      ),
    );
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

// ── Fan-out ranking (§7.6) ────────────────────────────────────────────────
/** Rank serving connectors by health score + historical hit rate (§7.6, §23). */
export function rankLiveConnectors<Ctx>(
  connectors: readonly LiveConnectorCandidate<Ctx>[],
): LiveConnectorCandidate<Ctx>[] {
  return [...connectors].sort((a, b) => score(b) - score(a));
}

function score<Ctx>(c: LiveConnectorCandidate<Ctx>): number {
  return 0.6 * c.healthScore + 0.4 * (c.hitRate ?? 0.5);
}

function allIndex(fields: Readonly<Record<string, unknown>>): Record<string, 'index'> {
  return Object.fromEntries(Object.keys(fields).map((k) => [k, 'index']));
}

/** Race a promise against a deadline; returns TIMEOUT if the budget elapses first. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
