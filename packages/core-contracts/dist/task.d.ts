/** Per-slot hash pin recorded at task-creation time. */
export interface SlotPin {
    readonly slotId: string;
    readonly promptHash: string;
    readonly templateVersion: string;
}
/** Maps role → array of slot pins assembled at task start (§9.3). */
export interface SlotPinDetail {
    readonly architect?: readonly SlotPin[];
    readonly executor?: readonly SlotPin[];
    readonly reviewer?: readonly SlotPin[];
    readonly decomposer?: readonly SlotPin[];
}
/** Phase A columns added to oweibo.tasks. */
export interface TaskPromptPins {
    readonly architectAssembledHash?: string;
    readonly executorAssembledHash?: string;
    readonly reviewerAssembledHash?: string;
    readonly decomposerAssembledHash?: string;
    readonly slotPinDetail?: SlotPinDetail;
    readonly cohortChannel: string;
    readonly projectId?: string;
}
/** Full persisted task record (IAgentTask + DB columns). */
export interface PersistedTask extends TaskPromptPins {
    readonly id: string;
    readonly tenantId: string;
    readonly userId?: string;
    readonly sessionId?: string;
    readonly taskMode: 'factory' | 'general-coding';
    readonly goalDescription: string;
    readonly goalContext?: string;
    readonly repoPath?: string;
    readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    readonly result?: unknown;
    readonly error?: string;
    readonly tokensUsed: number;
    readonly ttlSeconds?: number;
    readonly createdAt: Date;
    readonly startedAt?: Date;
    readonly completedAt?: Date;
}
/** Feedback signal written via POST /api/tasks/:id/feedback. */
export interface TaskFeedbackRecord {
    readonly id: string;
    readonly taskId: string;
    readonly tenantId: string;
    readonly userId?: string;
    readonly signal: 'thumbs_up' | 'thumbs_down';
    readonly createdAt: Date;
}
/** Prompt slot version row (oweibo.prompt_versions). */
export interface PromptVersionRecord {
    readonly hash: string;
    readonly role: string;
    readonly slotId: string;
    readonly templateVersion: string;
    readonly text: string;
    readonly parentHash?: string;
    readonly mutationStatus: 'stable' | 'fast' | 'beta' | 'guarded' | 'frozen' | 'pending_human_review' | 'retired';
    readonly freezeReason?: string;
    readonly evalScore?: unknown;
    readonly createdAt: Date;
    readonly updatedBy?: string;
}
/** Channel pointer row (oweibo.channels). */
export interface ChannelRecord {
    readonly name: string;
    readonly role: string;
    readonly slotId: string;
    readonly promptHash: string;
    readonly version: bigint;
    readonly updatedAt: Date;
    readonly updatedBy?: string;
}
//# sourceMappingURL=task.d.ts.map