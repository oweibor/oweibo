/**
 * SessionStore — cross-task session continuity (v5, §16b).
 *
 * Stores the history of tasks completed within a user session so the agent
 * can reference prior decisions, avoid repeating clarifications, and maintain
 * a coherent narrative across a multi-task workflow.
 *
 * Storage: Redis hash `session:{sessionId}` with a 7-day TTL (rolling).
 * Each append resets the TTL so active sessions never expire mid-flight.
 */

export interface SessionTaskSummary {
  readonly taskId: string;
  readonly goal: string;
  readonly outcome: 'success' | 'partial' | 'failed' | 'cancelled';
  readonly keyDecisions: readonly string[];
  readonly deliveredAt: string;   // ISO 8601
}

export interface SessionData {
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly createdAt: string;
  readonly tasks: SessionTaskSummary[];
  readonly clarifications: Record<string, string>;  // question → answer
}

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;  // 7 days

export class SessionStore {
  constructor(
    private readonly redisGet:   (key: string) => Promise<string | null>,
    private readonly redisSetEx: (key: string, ttl: number, value: string) => Promise<void>,
  ) {}

  private key(sessionId: string): string {
    return `session:${sessionId}`;
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const raw = await this.redisGet(this.key(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  }

  async save(data: SessionData): Promise<void> {
    await this.redisSetEx(this.key(data.sessionId), SESSION_TTL_SECONDS, JSON.stringify(data));
  }

  async appendTask(
    sessionId: string,
    userId: string,
    summary: SessionTaskSummary,
  ): Promise<void> {
    const existing = await this.load(sessionId);
    const session: SessionData = existing ?? {
      sessionId,
      userId,
      tenantId: '',
      createdAt: new Date().toISOString(),
      tasks: [],
      clarifications: {},
    };
    const updated: SessionData = {
      ...session,
      tasks: [...session.tasks, summary],
    };
    await this.save(updated);
  }

  async recordClarification(
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    const existing = await this.load(sessionId);
    if (!existing) return;
    await this.save({
      ...existing,
      clarifications: { ...existing.clarifications, [question]: answer },
    });
  }
}
