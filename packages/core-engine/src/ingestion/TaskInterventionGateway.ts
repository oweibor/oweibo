/**
 * TaskInterventionGateway — mid-task intervention support (v5, §16c).
 *
 * Allows users to pause, cancel, redirect, or approve a running task.
 * The CLI commands `oweibo pause/cancel/redirect/approve <taskId>` POST to
 * the REST API which calls the appropriate method here.
 *
 * Interventions are stored in Redis as transient keys with a short TTL.
 * Running workers poll this gateway (or are notified via pub/sub) to pick up
 * user commands between pipeline stages.
 *
 * Ownership: the gateway enforces that only the task's original submitter
 * can intervene. The task's `userId` is stored in `task:{taskId}:userId` at
 * submission time and compared before any intervention is applied.
 */

export type InterventionType = 'pause' | 'cancel' | 'redirect' | 'approve';

export interface TaskIntervention {
  readonly taskId: string;
  readonly type: InterventionType;
  readonly userId: string;
  readonly issuedAt: string;              // ISO 8601
  readonly redirectGoal?: string;         // populated when type === 'redirect'
  readonly source?: string;              // 'api' | 'cli' | 'channel'
  readonly channelReplyTarget?: unknown; // populated for channel-originated interventions
}

const INTERVENTION_TTL_SECONDS = 300;   // 5 minutes — long enough for any reasonable wait
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_TIMEOUT_MS       = 5 * 60 * 1000;  // 5 minutes

export class TaskInterventionGateway {
  constructor(
    private readonly redisSet:    (key: string, value: string) => Promise<void>,
    private readonly redisGet:    (key: string) => Promise<string | null>,
    private readonly redisSetEx:  (key: string, ttl: number, value: string) => Promise<void>,
    private readonly redisDel:    (key: string) => Promise<void>,
    private readonly redisGetStr: (key: string) => Promise<string | null>,
  ) {}

  private interventionKey(taskId: string): string {
    return `task:intervention:${taskId}`;
  }

  private ownerKey(taskId: string): string {
    return `task:${taskId}:userId`;
  }

  /** Register the task owner at submission time. */
  async registerOwner(taskId: string, userId: string): Promise<void> {
    await this.redisSetEx(this.ownerKey(taskId), 24 * 3600, userId);
  }

  /** Post an intervention command. Validates ownership. */
  async intervene(intervention: TaskIntervention): Promise<void> {
    const owner = await this.redisGetStr(this.ownerKey(intervention.taskId));
    if (owner && owner !== intervention.userId) {
      throw new Error(
        `[TaskInterventionGateway] User '${intervention.userId}' is not the owner of task '${intervention.taskId}'`,
      );
    }
    await this.redisSetEx(
      this.interventionKey(intervention.taskId),
      INTERVENTION_TTL_SECONDS,
      JSON.stringify(intervention),
    );
  }

  /** Check if an intervention has been posted (non-blocking). */
  async checkIntervention(taskId: string): Promise<TaskIntervention | null> {
    const raw = await this.redisGet(this.interventionKey(taskId));
    if (!raw) return null;
    return JSON.parse(raw) as TaskIntervention;
  }

  /** Consume and clear the intervention after it has been handled. */
  async consumeIntervention(taskId: string): Promise<TaskIntervention | null> {
    const intervention = await this.checkIntervention(taskId);
    if (intervention) await this.redisDel(this.interventionKey(taskId));
    return intervention;
  }

  /**
   * waitForApproval — blocks until the user posts an 'approve' or 'cancel' intervention.
   * Used by ConversationalLoop.planTurn() to hold execution until the plan is reviewed.
   * Times out after APPROVAL_TIMEOUT_MS and returns null (treated as implicit approval).
   */
  async waitForApproval(taskId: string): Promise<TaskIntervention | null> {
    const deadline = Date.now() + APPROVAL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const intervention = await this.checkIntervention(taskId);
      if (intervention?.type === 'approve' || intervention?.type === 'cancel') {
        await this.redisDel(this.interventionKey(taskId));
        return intervention;
      }
      await new Promise(resolve => setTimeout(resolve, APPROVAL_POLL_INTERVAL_MS));
    }

    // Timeout — return null (caller treats as implicit approval to unblock the task)
    console.warn(
      `[TaskInterventionGateway] Approval wait timed out for task '${taskId}' after ${APPROVAL_TIMEOUT_MS / 1000}s — proceeding without explicit approval`,
    );
    return null;
  }
}
