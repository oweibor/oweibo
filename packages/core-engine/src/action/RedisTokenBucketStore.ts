/**
 * S.2: RedisTokenBucketStore — Lua-script-backed token bucket for
 * multi-replica deployments.
 *
 * The companion InMemoryTokenBucketStore is per-process and silently
 * fails to enforce a global rate limit when the action-safety surface
 * runs on multiple replicas. This adapter executes all bucket math in
 * a single EVAL on the Redis server so refills, capacity checks, and
 * commits are atomic across replicas.
 *
 * The Lua script implements the classic continuous-refill formula:
 *   tokens(t) = min(capacity, tokens(t0) + capacity * (t - t0) / windowMs)
 *
 * One Redis key per (tenantId, actionClass, window). Each key stores a
 * single hash with two fields — `tokens` and `lastRefillMs` — and an
 * idle TTL set to 24h so an inactive (tenant, class) combination
 * naturally evicts without an extra reaper.
 *
 * The store is "Redis-like": callers can inject either an `ioredis` /
 * `redis` v4 client directly (both expose `.eval`) or any other shim
 * that satisfies IRedisLikeClient.
 */
import type {
  ITokenBucketStore,
  RateLimitWindowKind,
  RateLimitConsumption,
} from '@oweibo/core-contracts';

/**
 * Minimal Redis interface — both `ioredis` and `node-redis@4` clients
 * satisfy this shape. Callers can also pass a stub for tests.
 *
 * The args are stringified before being sent to the server (RESP-3
 * EVAL accepts only strings); the response is whatever the script
 * RETURNs, decoded through the client's reply protocol.
 */
export interface IRedisLikeClient {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

const WINDOW_MS: Readonly<Record<RateLimitWindowKind, number>> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/**
 * Lua: refill every supplied bucket, check capacity across all of them,
 * and commit consumption only if every bucket has the required tokens.
 *
 * KEYS = bucket keys, one per window
 * ARGV layout:
 *   [1]      nowMs            (number, ms since epoch)
 *   [2]      tokens to consume
 *   [3]      number of buckets (N)
 *   [4..]    for each bucket i: capacity_i (number), windowMs_i (number),
 *            windowKind_i (string, only echoed back)
 *
 * Returns:
 *   { 1, retryAfterMs (0), limitingWindow ('all') }      on success
 *   { 0, retryAfterMs, limitingWindow }                  on deny
 */
const LUA_TRY_CONSUME = `
local nowMs = tonumber(ARGV[1])
local tokens = tonumber(ARGV[2])
local n = tonumber(ARGV[3])

-- Phase 1: refill every bucket without writing back.
local pending = {}
for i = 1, n do
  local key       = KEYS[i]
  local capacity  = tonumber(ARGV[3 + (i - 1) * 3 + 1])
  local windowMs  = tonumber(ARGV[3 + (i - 1) * 3 + 2])
  local kind      = ARGV[3 + (i - 1) * 3 + 3]

  local stored = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
  local curTokens = tonumber(stored[1]) or capacity
  local lastMs    = tonumber(stored[2]) or nowMs

  -- Clip to new capacity if it shrank.
  if curTokens > capacity then curTokens = capacity end

  local elapsed = nowMs - lastMs
  if elapsed > 0 and curTokens < capacity then
    local refillRate = capacity / windowMs
    curTokens = math.min(capacity, curTokens + refillRate * elapsed)
  end

  pending[i] = { key = key, capacity = capacity, windowMs = windowMs,
                 kind = kind, tokens = curTokens }
end

-- Phase 2: check every bucket has capacity.
for i = 1, n do
  local b = pending[i]
  if b.tokens < tokens then
    local refillRate = b.capacity / b.windowMs
    local deficit = tokens - b.tokens
    local retryAfter
    if refillRate > 0 then
      retryAfter = math.ceil(deficit / refillRate)
    else
      retryAfter = -1
    end
    return { 0, retryAfter, b.kind }
  end
end

-- Phase 3: commit the consumption + persist updated state.
for i = 1, n do
  local b = pending[i]
  local newTokens = b.tokens - tokens
  redis.call('HMSET', b.key, 'tokens', tostring(newTokens), 'lastRefillMs', tostring(nowMs))
  -- 24h idle TTL so inactive buckets evict naturally.
  redis.call('PEXPIRE', b.key, 24 * 60 * 60 * 1000)
end

return { 1, 0, 'all' }
`;

const LUA_CONSUMPTION = `
local nowMs = tonumber(ARGV[1])
local n = tonumber(ARGV[2])
local out = {}
for i = 1, n do
  local key       = KEYS[i]
  local capacity  = tonumber(ARGV[2 + (i - 1) * 2 + 1])
  local windowMs  = tonumber(ARGV[2 + (i - 1) * 2 + 2])

  local stored = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
  local curTokens = tonumber(stored[1]) or capacity
  local lastMs    = tonumber(stored[2]) or nowMs
  if curTokens > capacity then curTokens = capacity end

  local elapsed = nowMs - lastMs
  if elapsed > 0 and curTokens < capacity then
    local refillRate = capacity / windowMs
    curTokens = math.min(capacity, curTokens + refillRate * elapsed)
  end

  -- Returns interleaved (used, capacity) per bucket.
  out[#out + 1] = tostring(capacity - curTokens)
  out[#out + 1] = tostring(capacity)
end
return out
`;

export interface RedisTokenBucketStoreOptions {
  /** Override clock; tests pin time. */
  now?: () => Date;
  /**
   * Key prefix applied before `<tenantId>:<actionClass>:<window>`.
   * Default 'oweibo:rl:'. Useful when sharing a Redis with other
   * services to avoid key collisions.
   */
  keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = 'oweibo:rl:';

export class RedisTokenBucketStore implements ITokenBucketStore {
  private readonly now: () => Date;
  private readonly keyPrefix: string;

  constructor(
    private readonly client: IRedisLikeClient,
    opts: RedisTokenBucketStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async tryConsume(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly buckets: ReadonlyArray<{ readonly window: RateLimitWindowKind; readonly capacity: number }>;
    readonly tokens?: number;
  }): Promise<{
    readonly allowed: boolean;
    readonly retryAfterMs: number;
    readonly limitingWindow: RateLimitWindowKind | 'all';
  }> {
    const tokens = args.tokens ?? 1;
    const nowMs = this.now().getTime();

    const keys: string[] = [];
    // ARGV[1..3] are framing; bucket-specific args follow in groups of 3.
    const argv: string[] = [String(nowMs), String(tokens), String(args.buckets.length)];
    for (const b of args.buckets) {
      keys.push(this.keyFor(args.tenantId, args.actionClass, b.window));
      argv.push(String(b.capacity), String(WINDOW_MS[b.window]), b.window);
    }

    const raw = await this.client.eval(LUA_TRY_CONSUME, keys.length, ...keys, ...argv);
    // Redis EVAL returns a Lua table; both ioredis and node-redis decode
    // it as an array. Values may be numbers (ioredis) or strings depending
    // on the client; coerce defensively.
    const arr = raw as [number | string, number | string, string];
    const allowed = Number(arr[0]) === 1;
    const retryAfterMs = Number(arr[1]);
    const window = String(arr[2]);
    return {
      allowed,
      retryAfterMs: retryAfterMs < 0 ? Number.POSITIVE_INFINITY : retryAfterMs,
      limitingWindow: (window as RateLimitWindowKind | 'all'),
    };
  }

  async consumption(args: {
    readonly tenantId: string;
    readonly actionClass: string;
    readonly capacities: { readonly minute: number; readonly hour: number; readonly day: number };
  }): Promise<RateLimitConsumption> {
    const nowMs = this.now().getTime();
    const order: RateLimitWindowKind[] = ['minute', 'hour', 'day'];
    const keys = order.map((w) => this.keyFor(args.tenantId, args.actionClass, w));
    const argv: string[] = [String(nowMs), String(order.length)];
    for (const w of order) {
      argv.push(String(args.capacities[w]), String(WINDOW_MS[w]));
    }
    const raw = await this.client.eval(LUA_CONSUMPTION, keys.length, ...keys, ...argv);
    const flat = (raw as Array<string | number>).map((v) => Number(v));
    return {
      minute: { used: flat[0] ?? 0, capacity: flat[1] ?? args.capacities.minute },
      hour:   { used: flat[2] ?? 0, capacity: flat[3] ?? args.capacities.hour   },
      day:    { used: flat[4] ?? 0, capacity: flat[5] ?? args.capacities.day    },
    };
  }

  private keyFor(tenantId: string, actionClass: string, window: RateLimitWindowKind): string {
    return `${this.keyPrefix}${tenantId}:${actionClass}:${window}`;
  }
}
