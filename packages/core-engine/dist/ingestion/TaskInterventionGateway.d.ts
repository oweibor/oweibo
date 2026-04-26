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
    readonly issuedAt: string;
    readonly redirectGoal?: string;
    readonly source?: string;
    readonly channelReplyTarget?: unknown;
}
export declare class TaskInterventionGateway {
    private readonly redisSet;
    private readonly redisGet;
    private readonly redisSetEx;
    private readonly redisDel;
    private readonly redisGetStr;
    constructor(redisSet: (key: string, value: string) => Promise<void>, redisGet: (key: string) => Promise<string | null>, redisSetEx: (key: string, ttl: number, value: string) => Promise<void>, redisDel: (key: string) => Promise<void>, redisGetStr: (key: string) => Promise<string | null>);
    private interventionKey;
    private ownerKey;
    /** Register the task owner at submission time. */
    registerOwner(taskId: string, userId: string): Promise<void>;
    /** Post an intervention command. Validates ownership. */
    intervene(intervention: TaskIntervention): Promise<void>;
    /** Check if an intervention has been posted (non-blocking). */
    checkIntervention(taskId: string): Promise<TaskIntervention | null>;
    /** Consume and clear the intervention after it has been handled. */
    consumeIntervention(taskId: string): Promise<TaskIntervention | null>;
    /**
     * waitForApproval — blocks until the user posts an 'approve' or 'cancel' intervention.
     * Used by ConversationalLoop.planTurn() to hold execution until the plan is reviewed.
     * Times out after APPROVAL_TIMEOUT_MS and returns null (treated as implicit approval).
     */
    waitForApproval(taskId: string): Promise<TaskIntervention | null>;
}
//# sourceMappingURL=TaskInterventionGateway.d.ts.map