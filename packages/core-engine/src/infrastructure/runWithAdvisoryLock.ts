/**
 * F.3.3 — runWithAdvisoryLock.
 *
 * Wraps a callback in a Postgres advisory lock so cron-driven aggregators
 * never run concurrently across replicas. Uses `pg_try_advisory_lock(key)`
 * (non-blocking): when the lock is held by another caller the wrapper
 * silently no-ops and returns `{ ran: false }`.
 *
 * Why this and not a row-based lock?
 *   - Advisory locks are cheap and survive only for the session, so a
 *     killed cron job doesn't wedge the schedule.
 *   - They live outside the data, so we don't need a table for "current
 *     leader" bookkeeping.
 *   - They don't interact with RLS — the lock space is global.
 *
 * Key derivation
 *   The caller supplies a string identifier (e.g. 'domain_currency_tick')
 *   and we hash it to a stable 32-bit signed integer. Postgres advisory
 *   locks use a bigint key; we store the hash in the low 32 bits and the
 *   high 32 are an oweibo namespace constant so two unrelated cron jobs
 *   in different services never collide.
 *
 * Callbacks
 *   The callback runs without the lock client (it can use its own pool/
 *   transactions). The lock client is released by the helper regardless
 *   of whether the callback throws. The callback's return value flows
 *   back through the `result` field.
 */
import type { Pool, PoolClient } from 'pg';

/** Reserved high-32 bits for advisory locks issued by oweibo cron jobs. */
const OWEIBO_LOCK_NAMESPACE = 0x6f776562;  // 'oweb' in ASCII.

export interface RunWithAdvisoryLockResult<T> {
  readonly ran: boolean;
  readonly result: T | undefined;
}

export interface RunWithAdvisoryLockOptions {
  /** Override clock; tests pin time. */
  readonly now?: () => Date;
  /** Logger; defaults to console. */
  readonly log?: (level: 'info' | 'warn' | 'error', line: string, ctx?: unknown) => void;
}

/**
 * Acquire `pg_try_advisory_lock(<derived key>)` and run the callback.
 * Returns `{ ran: true, result }` on success, `{ ran: false, result: undefined }`
 * when the lock was already held by another caller, and propagates any
 * exception thrown by the callback after releasing the lock.
 */
export async function runWithAdvisoryLock<T>(
  pool: Pool,
  lockId: string,
  fn: () => Promise<T>,
  opts: RunWithAdvisoryLockOptions = {},
): Promise<RunWithAdvisoryLockResult<T>> {
  const key = deriveLockKey(lockId);
  const log = opts.log ?? defaultLog;
  const client = await pool.connect();
  let acquired = false;
  try {
    const r = await client.query<{ pg_try_advisory_lock: boolean }>(
      `SELECT pg_try_advisory_lock($1::bigint) AS pg_try_advisory_lock`,
      [key],
    );
    acquired = r.rows[0]?.pg_try_advisory_lock === true;
    if (!acquired) {
      log('info', `advisory lock '${lockId}' busy — skipping tick`);
      return { ran: false, result: undefined };
    }
    const result = await fn();
    return { ran: true, result };
  } finally {
    if (acquired) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [key]);
      } catch (err) {
        log('warn', `pg_advisory_unlock for '${lockId}' threw — session close will release`, {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    client.release();
  }
}

/**
 * 64-bit key derivation. High 32 = oweibo namespace; low 32 = FNV-1a
 * hash of lockId truncated to int32. The combined value fits a signed
 * bigint that we send via $1::bigint.
 *
 * Exported for tests.
 */
export function deriveLockKey(lockId: string): string {
  const low = fnv1a32(lockId);
  // Combine into a 64-bit unsigned then convert to a signed string for
  // pg-node (which accepts BigInt-as-string for ::bigint params).
  const combined = (BigInt(OWEIBO_LOCK_NAMESPACE) << 32n) | BigInt(low);
  // Postgres bigint is signed; map the unsigned 64-bit value into the
  // signed range by subtracting 2^64 if the high bit is set.
  const signed = combined >= (1n << 63n) ? combined - (1n << 64n) : combined;
  return signed.toString();
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function defaultLog(level: 'info' | 'warn' | 'error', line: string, ctx?: unknown): void {
  const tag = `[runWithAdvisoryLock] ${line}`;
  if (level === 'error') console.error(tag, ctx ?? '');
  else if (level === 'warn') console.warn(tag, ctx ?? '');
  else console.log(tag, ctx ?? '');
}

/**
 * Internal: explicit unlock helper. Used by tests that want to confirm
 * the lock is released before another caller acquires it. Production
 * callers should rely on runWithAdvisoryLock's finally block.
 */
export async function _releaseLock(client: PoolClient, lockId: string): Promise<void> {
  const key = deriveLockKey(lockId);
  await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [key]);
}
