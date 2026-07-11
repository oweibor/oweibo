/**
 * K.1 convention layer — paginate / withRetry / webhook verification.
 */
import { paginate } from '../conventions/paginate.js';
import { withRetry, retryDelayMs } from '../conventions/retry.js';
import { computeWebhookSignature, verifyWebhookSignature } from '../conventions/webhook.js';
import { PortError } from '../ports/types.js';
import type { Cursor, Page } from '../ports/types.js';

function pagesOf<T>(items: readonly T[], pageSize: number, tailResumable: boolean) {
  return async (cursor: Cursor | null): Promise<Page<T>> => {
    const offset = cursor === null ? 0 : Number(cursor);
    const slice = items.slice(offset, offset + pageSize);
    const next = offset + slice.length;
    if (next < items.length) return { items: slice, nextCursor: String(next) };
    return { items: slice, nextCursor: tailResumable ? String(next) : null };
  };
}

describe('paginate', () => {
  it('drains a snapshot listing and returns null (not resumable)', async () => {
    const seen: number[] = [];
    const gen = paginate(pagesOf([1, 2, 3, 4, 5], 2, false));
    let r = await gen.next();
    while (!r.done) {
      seen.push(r.value);
      r = await gen.next();
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(r.value).toBeNull();
  });

  it('drains a delta listing and returns the tail resume cursor', async () => {
    const gen = paginate(pagesOf([1, 2, 3], 2, true));
    const seen: number[] = [];
    let r = await gen.next();
    while (!r.done) {
      seen.push(r.value);
      r = await gen.next();
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(r.value).toBe('3');
  });

  it('throws on a cursor that never progresses', async () => {
    const stuck = async (): Promise<Page<number>> => ({ items: [1], nextCursor: 'same' });
    const items: number[] = [];
    await expect(
      (async () => {
        for await (const i of paginate(stuck, { maxPages: 5 })) items.push(i);
      })(),
    ).rejects.toThrow(/maxPages/);
  });

  it('resumes from a supplied cursor', async () => {
    const seen: number[] = [];
    for await (const i of paginate(pagesOf([1, 2, 3, 4], 2, false), { cursor: '2' })) seen.push(i);
    expect(seen).toEqual([3, 4]);
  });
});

describe('withRetry', () => {
  it('retries transient PortErrors and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw PortError.transient('rate limited');
        return 'ok';
      },
      { sleep: async () => {}, random: () => 0.5 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('never retries permanent / corrupt_poison / unknown errors', async () => {
    for (const err of [PortError.permanent('revoked'), PortError.corruptPoison('bad payload'), new Error('mystery')]) {
      let calls = 0;
      await expect(
        withRetry(
          async () => {
            calls += 1;
            throw err;
          },
          { sleep: async () => {} },
        ),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it('exhausts maxAttempts and rethrows the last transient error', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw PortError.transient('still down');
        },
        { maxAttempts: 4, sleep: async () => {} },
      ),
    ).rejects.toThrow('still down');
    expect(calls).toBe(4);
  });

  it('full-jitter delay stays within [0, min(cap, base·2^(n−1)))', () => {
    expect(retryDelayMs(1, { baseDelayMs: 100, random: () => 0.999 })).toBeLessThan(100);
    expect(retryDelayMs(3, { baseDelayMs: 100, random: () => 0.999 })).toBeLessThan(400);
    expect(retryDelayMs(10, { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.999 })).toBeLessThan(1000);
    expect(retryDelayMs(2, { random: () => 0 })).toBe(0);
  });
});

describe('webhook signature verification', () => {
  it('accepts the correct signature and rejects tampering', () => {
    const body = JSON.stringify({ event: 'doc.updated', ref: 'doc-1' });
    const sig = computeWebhookSignature(body, 'wh-secret');
    expect(verifyWebhookSignature(body, sig, 'wh-secret')).toBe(true);
    expect(verifyWebhookSignature(body + ' ', sig, 'wh-secret')).toBe(false);
    expect(verifyWebhookSignature(body, sig, 'other-secret')).toBe(false);
  });

  it('rejects a wrong-length signature without throwing (no timing oracle)', () => {
    expect(verifyWebhookSignature('body', 'deadbeef', 's')).toBe(false);
  });
});
