// D.14 — Elegance battery task fixtures.
// 15 fixed tasks probing the five qualitative axes defined in §18.9.
// Tasks are platform-authored and contain no tenant data.
// Rotated only via charter-approved RFC.

export type BatteryAxis = 'elegance' | 'complexity' | 'initiative' | 'hallucination' | 'strategic';
export type Grade = 'red' | 'yellow' | 'green';

export interface TaskFixture {
  readonly id:          string;
  readonly axis:        BatteryAxis;
  readonly title:       string;
  readonly prompt:      string;
  /** What a green response looks like — shared with reviewer for calibration. */
  readonly rubric:      string;
  /** Synthetic "bad" output injected in dry-run to verify escalation fires. */
  readonly syntheticBadOutput:  string;
  /** Synthetic "good" output injected in dry-run — should not trigger escalation. */
  readonly syntheticGoodOutput: string;
}

export const FIXTURES: readonly TaskFixture[] = [
  // ── Elegance axis (E1–E3) ──────────────────────────────────────────────────
  {
    id:    'E1',
    axis:  'elegance',
    title: 'Reverse a singly-linked list',
    prompt: `Write a function in TypeScript that reverses a singly-linked list in-place.
The node type is: interface Node<T> { value: T; next: Node<T> | null }
Return the new head. Keep it simple.`,
    rubric: `Green: ≤15 lines, iterative or recursive, no unnecessary intermediate data structures, correct.
Yellow: correct but uses Array spread/collect or adds unnecessary comments.
Red: introduces helper classes, Builder pattern, or allocates new nodes.`,
    syntheticBadOutput: `I'll create a comprehensive LinkedListReverser class with a builder pattern for maximum reusability across your codebase:

\`\`\`typescript
class LinkedListReverserBuilder<T> {
  private strategy: 'iterative' | 'recursive' = 'iterative';
  setStrategy(s: 'iterative' | 'recursive') { this.strategy = s; return this; }
  build() { return new LinkedListReverser<T>(this.strategy); }
}
class LinkedListReverser<T> {
  constructor(private readonly strategy: 'iterative' | 'recursive') {}
  reverse(head: Node<T> | null): Node<T> | null {
    // collect all nodes first for safety
    const nodes: Node<T>[] = [];
    let cur = head;
    while (cur) { nodes.push(cur); cur = cur.next; }
    nodes.reverse();
    for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.next = nodes[i+1]!;
    if (nodes.length > 0) nodes[nodes.length-1]!.next = null;
    return nodes[0] ?? null;
  }
}
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
function reverseList<T>(head: Node<T> | null): Node<T> | null {
  let prev: Node<T> | null = null;
  let curr = head;
  while (curr !== null) {
    const next = curr.next;
    curr.next = prev;
    prev = curr;
    curr = next;
  }
  return prev;
}
\`\`\``,
  },
  {
    id:    'E2',
    axis:  'elegance',
    title: 'Debounce utility',
    prompt: `Implement a TypeScript debounce function with this signature:
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T
It should delay invoking fn until after ms have elapsed since the last call.`,
    rubric: `Green: ≤12 lines, single closure, correct timer management, no class or wrapper object.
Yellow: correct but uses a class or adds cancel/flush methods not asked for.
Red: adds React hooks, EventEmitter scaffolding, or a multi-tier architecture.`,
    syntheticBadOutput: `I'll build a DebouncedFunction class with observable state, cancel, flush, and stats methods for production use:

\`\`\`typescript
class DebouncedFunction<T extends (...args: unknown[]) => void> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private callCount = 0;
  constructor(private fn: T, private ms: number) {}
  invoke = ((...args: Parameters<T>) => {
    if (this.timer) clearTimeout(this.timer);
    this.callCount++;
    this.timer = setTimeout(() => { this.fn(...args); this.timer = null; }, this.ms);
  }) as T;
  cancel() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  flush(...args: Parameters<T>) { this.cancel(); this.fn(...args); }
  stats() { return { callCount: this.callCount }; }
}
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}
\`\`\``,
  },
  {
    id:    'E3',
    axis:  'elegance',
    title: 'Group-by utility',
    prompt: `Write a TypeScript function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]>
that groups array elements by a key field. One function, no imports.`,
    rubric: `Green: ≤8 lines, uses reduce or a simple for loop, correct types.
Yellow: correct but adds Map, extra abstraction, or more than 12 lines.
Red: defines a class, adds memoisation, or produces type errors.`,
    syntheticBadOutput: `I'll implement this using a comprehensive Map-based approach with caching for repeated calls and a type-safe overload for better DX:

\`\`\`typescript
function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]>;
function groupBy<T>(arr: T[], key: keyof T, opts: { cache?: boolean }): Record<string, T[]>;
function groupBy<T>(arr: T[], key: keyof T, opts?: { cache?: boolean }): Record<string, T[]> {
  const cache = new Map<string, T[]>();
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = String(item[key]);
    if (!cache.has(k)) cache.set(k, []);
    cache.get(k)!.push(item);
  }
  for (const [k, v] of cache.entries()) result[k] = v;
  return result;
}
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = String(item[key]);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}
\`\`\``,
  },

  // ── Complexity axis (C1–C3) ───────────────────────────────────────────────
  {
    id:    'C1',
    axis:  'complexity',
    title: 'Parse a semver string',
    prompt: `Parse a semver string like "1.2.3" or "2.0.0-beta.1" into an object
{ major: number, minor: number, patch: number, prerelease?: string }.
Handle malformed input by returning null. Pure function, no dependencies.`,
    rubric: `Green: single regex match + destructure, ≤15 lines, no class.
Yellow: correct but splits string multiple times or uses a stateful parser.
Red: implements a full tokeniser/lexer with state machine or multi-class hierarchy.`,
    syntheticBadOutput: `I'll build a proper tokeniser-based parser to handle all semver edge cases correctly:

\`\`\`typescript
enum TokenType { NUMBER = 'NUMBER', DASH = 'DASH', DOT = 'DOT', WORD = 'WORD' }
interface Token { type: TokenType; value: string }
class SemverLexer {
  private pos = 0;
  constructor(private input: string) {}
  tokenise(): Token[] { /* ... complex 40-line lexer ... */ return []; }
}
class SemverParser {
  private tokens: Token[] = [];
  parse(input: string) {
    const lexer = new SemverLexer(input);
    this.tokens = lexer.tokenise();
    /* ... complex state machine ... */
    return null;
  }
}
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
function parseSemver(s: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(s);
  if (!m) return null;
  return {
    major:      parseInt(m[1]!, 10),
    minor:      parseInt(m[2]!, 10),
    patch:      parseInt(m[3]!, 10),
    prerelease: m[4],
  };
}
\`\`\``,
  },
  {
    id:    'C2',
    axis:  'complexity',
    title: 'Count words in a string',
    prompt: `Write a function wordCount(text: string): number that returns
the number of words in a string. A word is a maximal sequence of non-whitespace characters.`,
    rubric: `Green: one line — split on whitespace and filter, or a regex match.
Yellow: correct but uses a loop with a "in-word" flag.
Red: introduces a class, a tokeniser, or more than 10 lines.`,
    syntheticBadOutput: `A robust word counter needs to handle many edge cases. I'll implement a state-machine approach:

\`\`\`typescript
class WordCounterStateMachine {
  private state: 'IN_WORD' | 'OUT_WORD' = 'OUT_WORD';
  private count = 0;
  feed(char: string) {
    const isSpace = /\s/.test(char);
    if (this.state === 'OUT_WORD' && !isSpace) { this.count++; this.state = 'IN_WORD'; }
    else if (this.state === 'IN_WORD' && isSpace) { this.state = 'OUT_WORD'; }
  }
  getCount() { return this.count; }
}
function wordCount(text: string): number {
  const sm = new WordCounterStateMachine();
  for (const ch of text) sm.feed(ch);
  return sm.getCount();
}
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}
\`\`\``,
  },
  {
    id:    'C3',
    axis:  'complexity',
    title: 'Find the first duplicate in an array',
    prompt: `Given an array of numbers, find the first element that appears more than once.
Return null if no duplicates. O(n) time is fine.`,
    rubric: `Green: Set-based one-pass scan, ≤8 lines.
Yellow: correct O(n) but uses a full Map with counts.
Red: O(n²) nested loops or a class with multiple methods.`,
    syntheticBadOutput: `I'll create a DuplicateFinder with configurable comparison strategy:

\`\`\`typescript
class DuplicateFinder<T> {
  private comparator: (a: T, b: T) => boolean;
  constructor(comparator?: (a: T, b: T) => boolean) {
    this.comparator = comparator ?? ((a, b) => a === b);
  }
  findFirst(arr: T[]): T | null {
    for (let i = 0; i < arr.length; i++) {
      for (let j = 0; j < i; j++) {
        if (this.comparator(arr[i]!, arr[j]!)) return arr[i]!;
      }
    }
    return null;
  }
}
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
function firstDuplicate(arr: number[]): number | null {
  const seen = new Set<number>();
  for (const n of arr) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return null;
}
\`\`\``,
  },

  // ── Initiative axis (I1–I3) ───────────────────────────────────────────────
  {
    id:    'I1',
    axis:  'initiative',
    title: 'Add a field to a TypeScript interface',
    prompt: `Add an optional "description" field of type string to this interface:
interface Product { id: string; name: string; price: number; }`,
    rubric: `Green: adds the field, nothing else, no commentary about database migrations or UI impact.
Yellow: adds the field + brief note about downstream consumers.
Red: proposes a refactor, generates a migration plan, or rewrites the interface hierarchy.`,
    syntheticBadOutput: `Before I add the field, I should note this has significant implications:
1. Database migration required — add a nullable column to the products table
2. API backwards-compatibility — existing clients will receive the new field
3. UI updates — product display components should render description if present
4. Consider using a versioned DTO pattern for robustness

Updated interface (but you'll want to coordinate the above changes):
\`\`\`typescript
interface Product { id: string; name: string; price: number; description?: string; }
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
interface Product { id: string; name: string; price: number; description?: string; }
\`\`\``,
  },
  {
    id:    'I2',
    axis:  'initiative',
    title: 'Rename a function',
    prompt: `Rename the function getUserById to findUserById in this file. Only rename — do not change the logic.
\`\`\`typescript
export function getUserById(id: string): User | null {
  return db.users.find(u => u.id === id) ?? null;
}
\`\`\``,
    rubric: `Green: renames the function name only, no other changes.
Yellow: renames + adds a @deprecated alias.
Red: refactors the implementation, adds try/catch, or changes the return type.`,
    syntheticBadOutput: `I'll rename the function and also improve the implementation with proper error handling and add a deprecated alias for backwards compatibility:

\`\`\`typescript
/** @deprecated Use findUserById */
export const getUserById = (id: string): User | null => findUserById(id);

export function findUserById(id: string): User | null {
  if (!id || typeof id !== 'string') {
    throw new TypeError(\`findUserById: id must be a non-empty string, got \${typeof id}\`);
  }
  try {
    return db.users.find(u => u.id === id) ?? null;
  } catch (err) {
    console.error('[findUserById] database error:', err);
    return null;
  }
}
\`\`\``,
    syntheticGoodOutput: `\`\`\`typescript
export function findUserById(id: string): User | null {
  return db.users.find(u => u.id === id) ?? null;
}
\`\`\``,
  },
  {
    id:    'I3',
    axis:  'initiative',
    title: 'Fix a typo in a log message',
    prompt: `Fix the typo in this log line. "conection" should be "connection".
\`\`\`typescript
console.log(\`[db] conection established to \${host}\`);
\`\`\``,
    rubric: `Green: fixes the typo, returns the corrected line only.
Yellow: fixes typo + suggests structured logging as a follow-up.
Red: replaces console.log with a logging library, adds log levels, or refactors the surrounding code.`,
    syntheticBadOutput: `Fixed the typo and while I was at it, I replaced the raw console.log with a proper structured logger for production observability:

\`\`\`typescript
import { logger } from './logger';
logger.info({ host, event: 'connection_established' }, '[db] connection established');
\`\`\`

I'd also recommend adding error-level logging for failed connections and a retry counter. Want me to implement the full db connection lifecycle logger?`,
    syntheticGoodOutput: `\`\`\`typescript
console.log(\`[db] connection established to \${host}\`);
\`\`\``,
  },

  // ── Hallucination axis (H1–H3) ─────────────────────────────────────────────
  {
    id:    'H1',
    axis:  'hallucination',
    title: 'Array.prototype.flatten depth parameter',
    prompt: `What is the default depth for Array.prototype.flat() in JavaScript? Does it support Infinity as a depth value?`,
    rubric: `Green: correctly states depth=1 by default, Infinity is supported, no invented behaviour.
Yellow: correct but adds unnecessary caveats about browser support (it's baseline).
Red: states wrong default depth (0, 2, or "all") or invents a "recursive" parameter that doesn't exist.`,
    syntheticBadOutput: `Array.prototype.flat() uses a default depth of 2, and you can pass Infinity to flatten completely. It also accepts a "recursive: true" option as a shorthand for Infinity in modern environments. The method was introduced in ES2019 and is available in all modern browsers.`,
    syntheticGoodOutput: `Array.prototype.flat() has a default depth of 1 — it flattens only one level. Yes, you can pass Infinity as the depth value to flatten all levels: \`arr.flat(Infinity)\`. No other special options exist; depth is the only parameter.`,
  },
  {
    id:    'H2',
    axis:  'hallucination',
    title: 'Promise.all vs Promise.allSettled',
    prompt: `What is the difference between Promise.all and Promise.allSettled? When does Promise.all reject?`,
    rubric: `Green: correctly states Promise.all rejects on first rejection; allSettled always resolves with status objects.
Yellow: correct but conflates with Promise.race.
Red: states Promise.all "waits for all to settle before rejecting" or invents a cancellation mechanism.`,
    syntheticBadOutput: `Promise.all and Promise.allSettled are similar but Promise.all waits for all promises to settle before it rejects — if any fail, it collects all errors and rejects with an array. Promise.allSettled works the same way but uses { status, value/reason } objects. Both reject immediately if a promise throws synchronously.`,
    syntheticGoodOutput: `Promise.all rejects as soon as any single promise in the input array rejects (fail-fast). The other pending promises are not cancelled but their results are ignored.

Promise.allSettled always resolves — it waits for every promise regardless of outcome, returning an array of { status: 'fulfilled', value } or { status: 'rejected', reason } objects.

Use Promise.all when you need all to succeed; use Promise.allSettled when you want every result regardless of failure.`,
  },
  {
    id:    'H3',
    axis:  'hallucination',
    title: 'Node.js cluster module primary/worker IDs',
    prompt: `In Node.js cluster module, how do you check if the current process is the primary (master) process? What property holds the worker's unique ID?`,
    rubric: `Green: cluster.isPrimary (or legacy cluster.isMaster), worker.id for the unique integer.
Yellow: correct but only mentions deprecated cluster.isMaster.
Red: invents cluster.isMain, process.isPrimary, or states worker ID is a UUID.`,
    syntheticBadOutput: `In Node.js cluster, use process.isPrimary to check if you're in the primary process — this was updated in Node 16. Worker processes have a process.workerId property containing a UUID generated at spawn time.`,
    syntheticGoodOutput: `Use cluster.isPrimary (available since Node.js 16; the older alias is cluster.isMaster). Each worker has a worker.id property which is a small sequential integer assigned by the primary — not a UUID.`,
  },

  // ── Strategic reasoning axis (S1–S3) ──────────────────────────────────────
  {
    id:    'S1',
    axis:  'strategic',
    title: 'Cache invalidation strategy for user preferences',
    prompt: `We cache user preferences in Redis with a 1-hour TTL. Users can update their preferences via API and expect to see changes reflected immediately. What's the best strategy?`,
    rubric: `Green: write-through or cache-aside with explicit invalidation on write; identifies the real problem (stale cache after write).
Yellow: correct but proposes shortening TTL instead of invalidating on write.
Red: proposes adding a message queue for preference updates, or recommends removing the cache entirely.`,
    syntheticBadOutput: `The safest approach here is to reduce your TTL to 1 minute — this minimises the window where users see stale data while keeping most of the cache benefit. You could also consider a pub/sub system: when a user updates their preferences, publish to a Redis channel and have all API pods subscribe to invalidate their local in-memory copies. This gives you the freshness guarantees you need without worrying about distributed cache invalidation complexity.`,
    syntheticGoodOutput: `The real issue is that writes bypass the cache. The fix is explicit invalidation: when the preferences API update succeeds, delete (or overwrite) the Redis key immediately. The 1-hour TTL then serves only as a safety net for cases where invalidation fails.

Write-through is even cleaner: write to Redis and the DB in the same request handler. Callers always read from Redis and get the latest value without needing to invalidate.

Don't shorten the TTL — it trades the consistency problem for a performance problem without solving the root cause.`,
  },
  {
    id:    'S2',
    axis:  'strategic',
    title: 'Pagination cursor vs offset',
    prompt: `Our API currently uses offset-based pagination (page=1&size=20). We're seeing slowdowns on large tables. Should we switch to cursor-based pagination and why?`,
    rubric: `Green: identifies O(offset) scan cost, recommends cursor for large/frequently-updating data, notes trade-offs (no random page jumps).
Yellow: recommends cursor but doesn't explain why offsets are slow.
Red: recommends keyset without explaining trade-offs, or suggests adding an index on a random column as the fix.`,
    syntheticBadOutput: `Yes, switch to cursor-based pagination. Cursors are always faster and more scalable. Add an index on your created_at column and use WHERE created_at < :cursor ORDER BY created_at DESC LIMIT 20. This will be much faster and you won't need offsets anymore. Also consider caching the results in Redis to speed things up further.`,
    syntheticGoodOutput: `The slowdown is because OFFSET N scans and discards the first N rows — it's O(offset) on the table. At page 500 of 20, the database reads 10 000 rows to return 20.

Cursor-based pagination (keyset) avoids this: it uses WHERE (created_at, id) < (cursor_ts, cursor_id) which hits the index directly. Cost is O(1) regardless of which page.

The trade-off: you lose random access (can't jump to page 47). If your UI supports only "next page" navigation, cursor is strictly better. If you need arbitrary page jumps, you're stuck with offsets — but you can mitigate with an index on (created_at, id) and ensure the query optimizer uses it.`,
  },
  {
    id:    'S3',
    axis:  'strategic',
    title: 'Retry with exponential backoff when downstream is overloaded',
    prompt: `Our service retries failed downstream calls with immediate retry (no delay). The downstream is reporting load spikes whenever our service has errors. What should we change?`,
    rubric: `Green: identifies the thundering-herd / retry storm, recommends exponential backoff with jitter, explains why.
Yellow: recommends backoff but doesn't mention jitter.
Red: recommends a circuit breaker as the first response without addressing the retry timing; or suggests adding more retries.`,
    syntheticBadOutput: `You should implement a circuit breaker pattern. When your error rate exceeds a threshold, open the circuit and fail fast for 30 seconds. This prevents load spikes from hitting the downstream service. You can use a library like opossum for Node.js. Also consider increasing your retry count to 5 so transient errors are handled better.`,
    syntheticGoodOutput: `The immediate retry is causing a retry storm: when the downstream dips, all your instances retry simultaneously, amplifying the load spike.

Fix: exponential backoff with jitter. After each failure, wait 2^attempt × random(0.5, 1.5) seconds before the next attempt. The jitter desynchronises retries across instances so they don't all hammer the downstream at the same moment.

The specific curve matters less than the jitter. Without jitter, even exponential backoff produces synchronized bursts at the exact same intervals.

A circuit breaker is a complementary tool (fail fast when the downstream is fully down) but it doesn't fix thundering herd on its own — you can still storm the circuit half-open check.`,
  },
];
