/**
 * K.9 — the connector simulation environment. Roadmap: "Connector simulation
 * environment built BEFORE the third connector."
 *
 * Certification (`certificationRunner`) proves a bundle satisfies the port
 * contracts in isolation. The simulator is the complementary tool: it drives a
 * bundle's Glean lifecycle END-TO-END the way the platform runtime will —
 * initial crawl → index each discovered object via the content port → snapshot
 * each object's ACL → apply a source mutation → verify the delta feed resumes
 * from the tail with ONLY the change. It exercises the composition of ports the
 * runtime relies on, which no single per-port contract test covers.
 *
 * It is connector-agnostic (it only touches the SDK port interfaces on a
 * bundle), so it is the harness the second and third connectors are validated
 * through without re-writing a driver each time — the "real test" the roadmap's
 * effort budgets are measured against.
 */
import type { ConnectorBundle } from '../declareConnector.js';
import type { ConnectorContext } from '../context.js';
import type { ChangeEvent } from '../ports/changeFeed.js';
import type { AclSnapshot } from '../ports/acl.js';
import { makeMockContext } from './mockSource.js';

export interface IndexedObject {
  readonly ref: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly acl?: AclSnapshot;
}

export interface SimulationReport {
  /** Objects discovered by the initial crawl and successfully indexed. */
  readonly indexed: readonly IndexedObject[];
  /** The tail cursor after the crawl — the standing delta resume point. */
  readonly tailCursor: string | null;
  /** Whether the feed is delta-resumable (tail cursor is non-null). */
  readonly deltaResumable: boolean;
  /** Change events returned by a delta poll after a mutation, if one was applied. */
  readonly deltaAfterMutation?: readonly ChangeEvent[];
}

export interface SimulationOptions {
  readonly ctx?: ConnectorContext;
  /** Cap crawl pages so a mis-implemented non-terminating feed fails loudly. */
  readonly maxPages?: number;
  /**
   * A mutation to apply to the underlying source AFTER the crawl, to verify
   * delta resume. The simulator does not know how to mutate a specific source,
   * so the caller supplies the closure; the simulator then polls the tail.
   */
  readonly mutate?: () => void | Promise<void>;
}

/**
 * Drive a bundle's Glean lifecycle end-to-end. Returns what was indexed, the
 * delta resume point, and (if a mutation was supplied) the delta the tail poll
 * observed.
 */
export async function simulateConnector(
  bundle: ConnectorBundle,
  opts: SimulationOptions = {},
): Promise<SimulationReport> {
  const ctx = opts.ctx ?? makeMockContext();
  const maxPages = opts.maxPages ?? 1000;
  const changeFeed = bundle.spec.ports?.changeFeed;
  const content = bundle.spec.ports?.content;
  const acl = bundle.spec.ports?.acl;
  if (!changeFeed) throw new Error('simulateConnector: bundle has no changeFeed port');
  if (!content) throw new Error('simulateConnector: bundle has no content port');

  // 1. Initial crawl — drain the feed to its tail, collecting live refs. A
  //    delete cancels an earlier create (the runtime never indexes a tombstone).
  const live = new Map<string, ChangeEvent>();
  let cursor: string | null = null;
  let tailCursor: string | null = null;
  let pages = 0;
  for (;;) {
    if (pages++ > maxPages) throw new Error('simulateConnector: crawl exceeded maxPages (non-terminating feed?)');
    const page = await changeFeed.listChanges(ctx, cursor);
    for (const ev of page.items) {
      if (ev.kind === 'deleted') live.delete(ev.ref);
      else live.set(ev.ref, ev);
    }
    // Tail convention: an empty page with a non-null cursor is the resume point.
    if (page.items.length === 0 && page.nextCursor !== null) { tailCursor = page.nextCursor; break; }
    if (page.nextCursor === null) { tailCursor = null; break; }
    cursor = page.nextCursor;
  }

  // 2. Index each live object via the content port; 3. snapshot its ACL.
  const indexed: IndexedObject[] = [];
  for (const ref of live.keys()) {
    const c = await content.fetchContent(ctx, ref);
    const obj: IndexedObject = {
      ref,
      fields: c.fields,
      revision: c.revision,
      acl: acl ? await acl.fetchAcl(ctx, ref) : undefined,
    };
    indexed.push(obj);
  }

  const report: SimulationReport = {
    indexed,
    tailCursor,
    deltaResumable: tailCursor !== null,
  };

  // 4. If a mutation was supplied, apply it and verify the tail poll observes
  //    ONLY the change (delta resume, not full re-crawl).
  if (opts.mutate && tailCursor !== null) {
    await opts.mutate();
    const delta = await changeFeed.listChanges(ctx, tailCursor);
    return { ...report, deltaAfterMutation: delta.items };
  }

  return report;
}
