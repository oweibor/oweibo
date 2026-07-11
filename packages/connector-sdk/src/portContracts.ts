/**
 * K.1 — per-port contract tests (ADR-012 §7, battery item c) and the
 * `demonstrated` SupportMap they produce for the INV-15 truthfulness
 * check (battery item b).
 *
 * This is the harness the ratification-time predicate was waiting for:
 * `checkManifestTruthfulness` (contract/) is the pure rule; this module
 * exercises live port bindings to build the `demonstrated` side.
 *
 * What "demonstrated" means per flag (v1 probes — Expected to evolve):
 *   changeFeed       feed drains: bounded pages, progressing cursor
 *   content          ≥1 ref fetched with fields + non-empty revision
 *   acl              ≥1 ref fetched with aclVersion + principals[]
 *   principals       listing drains with well-formed principals
 *   activity         listing drains
 *   activitySignals  = activity (both name the ActivityPort face)
 *   actions          capabilities[] non-empty AND sandbox step passed
 *                    (computed by the runner, which owns that step)
 *   deltaSync        the drained feed ends in a standing tail cursor and
 *                    polling that cursor returns no duplicates — i.e.
 *                    the cursor is a real resume point, not a fresh crawl
 *   webhooks         registerWebhook + unregisterWebhook round-trip
 *   groups           listGroups exists and drains
 */
import type { ConnectorContext } from './context.js';
import type { ConnectorBundle } from './declareConnector.js';
import type { SupportFlag, SupportMap } from './contract/manifestTruthfulness.js';
import type { Cursor, Page, PortBase } from './ports/types.js';

export interface PortContractReport {
  /** One entry per exercised surface, e.g. 'changeFeed', 'webhooks'. */
  readonly exercised: readonly string[];
  readonly violations: readonly string[];
  /** Feeds checkManifestTruthfulness (actions is the runner's to add). */
  readonly demonstrated: SupportMap;
}

/** Pages a contract drain will walk before declaring the cursor broken. */
const MAX_CONTRACT_PAGES = 1_000;

interface DrainResult<T> {
  readonly items: T[];
  readonly tailCursor: Cursor | null;
  readonly violations: string[];
}

async function drain<T>(
  name: string,
  list: (cursor: Cursor | null) => Promise<Page<T>>,
): Promise<DrainResult<T>> {
  const items: T[] = [];
  const violations: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: Cursor | null = null;

  for (let pages = 0; ; pages++) {
    if (pages >= MAX_CONTRACT_PAGES) {
      violations.push(`${name}: cursor did not progress within ${MAX_CONTRACT_PAGES} pages`);
      return { items, tailCursor: cursor, violations };
    }
    let page: Page<T>;
    try {
      page = await list(cursor);
    } catch (err) {
      violations.push(`${name}: listing threw: ${err instanceof Error ? err.message : String(err)}`);
      return { items, tailCursor: cursor, violations };
    }
    if (!Array.isArray(page.items)) {
      violations.push(`${name}: page.items is not an array (cursor-page contract, ADR-012 §3.2)`);
      return { items, tailCursor: cursor, violations };
    }
    items.push(...page.items);

    if (page.nextCursor === null) return { items, tailCursor: null, violations };
    if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0) {
      violations.push(`${name}: nextCursor must be an opaque non-empty string or null`);
      return { items, tailCursor: null, violations };
    }
    // Caught-up delta feed: empty page re-issuing its own cursor is the
    // standing resume point — the legitimate terminal state.
    if (page.items.length === 0 && page.nextCursor === cursor) {
      return { items, tailCursor: page.nextCursor, violations };
    }
    if (seenCursors.has(page.nextCursor)) {
      violations.push(`${name}: cursor ${page.nextCursor} repeated with items — the feed loops`);
      return { items, tailCursor: page.nextCursor, violations };
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

async function checkBase(
  name: string,
  port: PortBase<ConnectorContext>,
  ctx: ConnectorContext,
  violations: string[],
): Promise<boolean> {
  if (port.apiVersion !== 'v1') {
    violations.push(`${name}: unsupported apiVersion ${String(port.apiVersion)} (host supports v1)`);
    return false;
  }
  if (typeof port.probe !== 'function') {
    violations.push(`${name}: missing health probe (per-port probes are normative, ADR-012 §3.2)`);
    return false;
  }
  try {
    const probe = await port.probe(ctx);
    if (probe.ok !== true) {
      violations.push(`${name}: probe reported unhealthy${probe.detail ? `: ${probe.detail}` : ''}`);
      return false;
    }
  } catch (err) {
    violations.push(`${name}: probe threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  return true;
}

export async function runPortContractTests(
  bundle: ConnectorBundle,
  ctx: ConnectorContext,
  fixtures: Readonly<Record<string, unknown>> = {},
): Promise<PortContractReport> {
  const ports = bundle.spec.ports ?? {};
  const exercised: string[] = [];
  const violations: string[] = [];
  const demonstrated: Partial<Record<SupportFlag, boolean>> = {};

  // ── changeFeed (+ deltaSync) ───────────────────────────────────────────
  let feedRefs: string[] = [];
  if (ports.changeFeed) {
    exercised.push('changeFeed');
    const before = violations.length;
    if (await checkBase('changeFeed', ports.changeFeed, ctx, violations)) {
      const cf = ports.changeFeed;
      const d = await drain('changeFeed', (c) => cf.listChanges(ctx, c));
      violations.push(...d.violations);
      feedRefs = d.items
        .filter((e) => e.kind === 'created' || e.kind === 'updated')
        .map((e) => e.ref);
      if (violations.length === before) {
        demonstrated.changeFeed = true;
        // deltaSync: the tail cursor must be a real resume point.
        if (d.tailCursor !== null) {
          exercised.push('deltaSync');
          try {
            const again = await cf.listChanges(ctx, d.tailCursor);
            if (again.items.length === 0) demonstrated.deltaSync = true;
            else violations.push('deltaSync: polling the tail cursor replayed items — not a delta feed');
          } catch (err) {
            violations.push(`deltaSync: tail-cursor poll threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  // Refs for content/acl come from the feed, or explicit fixtures for
  // connectors certified without a change feed.
  const fixtureRefs = Array.isArray(fixtures['contentRefs'])
    ? (fixtures['contentRefs'] as string[])
    : [];
  const refs = (feedRefs.length > 0 ? feedRefs : fixtureRefs).slice(0, 5);

  // ── content ────────────────────────────────────────────────────────────
  if (ports.content) {
    exercised.push('content');
    const before = violations.length;
    if (await checkBase('content', ports.content, ctx, violations)) {
      if (refs.length === 0) {
        violations.push('content: no refs to fetch — supply a changeFeed or fixtures.contentRefs');
      }
      for (const ref of refs) {
        try {
          const r = await ports.content.fetchContent(ctx, ref);
          if (r === null || typeof r.fields !== 'object' || r.fields === null) {
            violations.push(`content: ${ref} returned no fields object`);
          }
          if (typeof r.revision !== 'string' || r.revision.length === 0) {
            violations.push(`content: ${ref} returned an empty revision — (ref, revision) is the idempotency key (ADR-013)`);
          }
        } catch (err) {
          violations.push(`content: fetchContent(${ref}) threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (violations.length === before) demonstrated.content = true;
    }
  }

  // ── acl ────────────────────────────────────────────────────────────────
  if (ports.acl) {
    exercised.push('acl');
    const before = violations.length;
    if (await checkBase('acl', ports.acl, ctx, violations)) {
      if (refs.length === 0) {
        violations.push('acl: no refs to fetch — supply a changeFeed or fixtures.contentRefs');
      }
      for (const ref of refs) {
        try {
          const snap = await ports.acl.fetchAcl(ctx, ref);
          if (typeof snap.aclVersion !== 'string' || snap.aclVersion.length === 0) {
            violations.push(`acl: ${ref} returned an empty aclVersion`);
          }
          if (!Array.isArray(snap.principals)) {
            violations.push(`acl: ${ref} returned no principals array`);
          }
        } catch (err) {
          violations.push(`acl: fetchAcl(${ref}) threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (violations.length === before) demonstrated.acl = true;
    }
  }

  // ── principals (+ groups) ──────────────────────────────────────────────
  if (ports.principals) {
    exercised.push('principals');
    const before = violations.length;
    if (await checkBase('principals', ports.principals, ctx, violations)) {
      const pp = ports.principals;
      const d = await drain('principals', (c) => pp.listPrincipals(ctx, c));
      violations.push(...d.violations);
      for (const p of d.items) {
        if (typeof p.id !== 'string' || p.id.length === 0) {
          violations.push('principals: a principal has no stable id');
          break;
        }
      }
      if (violations.length === before) demonstrated.principals = true;

      if (typeof pp.listGroups === 'function') {
        exercised.push('groups');
        const gBefore = violations.length;
        const listGroups = pp.listGroups.bind(pp);
        const g = await drain('groups', (c) => listGroups(ctx, c));
        violations.push(...g.violations);
        if (violations.length === gBefore) demonstrated.groups = true;
      }
    }
  }

  // ── activity (+ activitySignals) ───────────────────────────────────────
  if (ports.activity) {
    exercised.push('activity');
    const before = violations.length;
    if (await checkBase('activity', ports.activity, ctx, violations)) {
      const ap = ports.activity;
      const d = await drain('activity', (c) => ap.listActivity(ctx, c));
      violations.push(...d.violations);
      if (violations.length === before) {
        demonstrated.activity = true;
        demonstrated.activitySignals = true;
      }
    }
  }

  // ── webhooks (lifecycle-hook round-trip) ───────────────────────────────
  if (bundle.spec.registerWebhook && bundle.spec.unregisterWebhook) {
    exercised.push('webhooks');
    const before = violations.length;
    try {
      await bundle.spec.registerWebhook(ctx);
      await bundle.spec.unregisterWebhook(ctx);
    } catch (err) {
      violations.push(`webhooks: register/unregister round-trip threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (violations.length === before) demonstrated.webhooks = true;
  }

  return { exercised, violations, demonstrated };
}
