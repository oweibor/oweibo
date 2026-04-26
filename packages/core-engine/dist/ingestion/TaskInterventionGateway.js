"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskInterventionGateway = void 0;
const INTERVENTION_TTL_SECONDS = 300; // 5 minutes — long enough for any reasonable wait
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
class TaskInterventionGateway {
    redisSet;
    redisGet;
    redisSetEx;
    redisDel;
    redisGetStr;
    constructor(redisSet, redisGet, redisSetEx, redisDel, redisGetStr) {
        this.redisSet = redisSet;
        this.redisGet = redisGet;
        this.redisSetEx = redisSetEx;
        this.redisDel = redisDel;
        this.redisGetStr = redisGetStr;
    }
    interventionKey(taskId) {
        return `task:intervention:${taskId}`;
    }
    ownerKey(taskId) {
        return `task:${taskId}:userId`;
    }
    /** Register the task owner at submission time. */
    async registerOwner(taskId, userId) {
        await this.redisSetEx(this.ownerKey(taskId), 24 * 3600, userId);
    }
    /** Post an intervention command. Validates ownership. */
    async intervene(intervention) {
        const owner = await this.redisGetStr(this.ownerKey(intervention.taskId));
        if (owner && owner !== intervention.userId) {
            throw new Error(`[TaskInterventionGateway] User '${intervention.userId}' is not the owner of task '${intervention.taskId}'`);
        }
        await this.redisSetEx(this.interventionKey(intervention.taskId), INTERVENTION_TTL_SECONDS, JSON.stringify(intervention));
    }
    /** Check if an intervention has been posted (non-blocking). */
    async checkIntervention(taskId) {
        const raw = await this.redisGet(this.interventionKey(taskId));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    /** Consume and clear the intervention after it has been handled. */
    async consumeIntervention(taskId) {
        const intervention = await this.checkIntervention(taskId);
        if (intervention)
            await this.redisDel(this.interventionKey(taskId));
        return intervention;
    }
    /**
     * waitForApproval — blocks until the user posts an 'approve' or 'cancel' intervention.
     * Used by ConversationalLoop.planTurn() to hold execution until the plan is reviewed.
     * Times out after APPROVAL_TIMEOUT_MS and returns null (treated as implicit approval).
     */
    async waitForApproval(taskId) {
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
        console.warn(`[TaskInterventionGateway] Approval wait timed out for task '${taskId}' after ${APPROVAL_TIMEOUT_MS / 1000}s — proceeding without explicit approval`);
        return null;
    }
}
exports.TaskInterventionGateway = TaskInterventionGateway;
//# sourceMappingURL=TaskInterventionGateway.js.map