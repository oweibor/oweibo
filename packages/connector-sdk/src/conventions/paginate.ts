/**
 * K.1 convention (ADR-012 §3.2/§3.5) — AsyncIterable sugar over cursor
 * pages. The *contract* is the cursor page; this is the ergonomic wrapper
 * so adapter-internal composition (and tests) can `for await` without
 * hand-rolling the drain loop.
 *
 * Note the platform runtime does its own draining (with checkpointing,
 * quota accounting, and retry around every page — §3.5 pipeline); this
 * helper is for authored code and harnesses, which is why it lives in
 * the SDK and not the runtime.
 */
import type { Cursor, Page } from '../ports/types.js';

export interface PaginateOptions {
  /** Start cursor (resume point); null = from the beginning. */
  readonly cursor?: Cursor | null;
  /**
   * Hard ceiling on pages walked — a defense against a cursor that never
   * progresses (which certification separately flags as a contract
   * violation). Default 10_000.
   */
  readonly maxPages?: number;
}

/**
 * Drain a cursor-paged listing item by item. Stops when a page returns
 * `nextCursor: null` OR an empty page repeats its cursor (caught-up
 * delta feed — the tail cursor is a resume point, not more data).
 * Throws when `maxPages` is exceeded (a non-progressing cursor).
 */
export async function* paginate<T>(
  fetchPage: (cursor: Cursor | null) => Promise<Page<T>>,
  opts: PaginateOptions = {},
): AsyncGenerator<T, Cursor | null, undefined> {
  const maxPages = opts.maxPages ?? 10_000;
  let cursor: Cursor | null = opts.cursor ?? null;
  let pages = 0;

  for (;;) {
    if (pages >= maxPages) {
      throw new Error(`paginate: exceeded maxPages=${maxPages} — cursor is not progressing`);
    }
    const page = await fetchPage(cursor);
    pages += 1;
    for (const item of page.items) yield item;

    if (page.nextCursor === null) return null;           // exhausted, not resumable
    if (page.items.length === 0 && page.nextCursor === cursor) {
      return page.nextCursor;                            // caught up; tail resume point
    }
    cursor = page.nextCursor;
  }
}
