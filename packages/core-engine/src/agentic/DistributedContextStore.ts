/**
 * DistributedContextStore — Redis-backed key-value store for cross-worker task state.
 *
 * Enables worker-restart resilience: if a worker crashes mid-task, the new worker
 * can load the last saved state and resume from the correct turn index rather than
 * starting over. Used by ConversationalLoop, GeneralCodingOrchestrator, and SwarmCoordinator.
 *
 * Keys are namespaced by purpose (e.g. `gc-session:{taskId}`, `gc-plan:{taskId}`).
 * Default TTL: 24 hours — sufficient for any single task's lifetime.
 */

export interface ContextRecord {
  readonly id: string;
  [key: string]: unknown;
}

const CONTEXT_TTL_SECONDS = 24 * 60 * 60;

export class DistributedContextStore {
  constructor(
    private readonly redisGet:   (key: string) => Promise<string | null>,
    private readonly redisSetEx: (key: string, ttl: number, value: string) => Promise<void>,
    private readonly redisDel:   (key: string) => Promise<void>,
  ) {}

  async save(record: ContextRecord): Promise<void> {
    await this.redisSetEx(record.id, CONTEXT_TTL_SECONDS, JSON.stringify(record));
  }

  async load(id: string): Promise<ContextRecord | null> {
    const raw = await this.redisGet(id);
    if (!raw) return null;
    return JSON.parse(raw) as ContextRecord;
  }

  async delete(id: string): Promise<void> {
    await this.redisDel(id);
  }
}
