// TODO(RFC): Phase D.2 — Thompson sampling bandit per slot.
// This stub always returns the channel-pointer hash (no exploration).
// Full implementation: Beta(α,β) posterior per (channel, slotId, promptHash),
// 5% forced exploration to newest GEPA-staged candidate.

import type { Pool } from 'pg';

export class BanditService {
  constructor(
    private readonly pg: Pool, // eslint-disable-line @typescript-eslint/no-unused-vars
  ) {}

  /** Phase D.2 stub — returns undefined (caller falls back to channel pointer). */
  draw(_channel: string, _slotId: string, _taskId: string): string | undefined {
    return undefined;
  }

  /** Phase D.2 stub — no-op. */
  recordReward(_taskId: string, _slotId: string, _armId: string, _reward: number): Promise<void> {
    return Promise.resolve();
  }
}
