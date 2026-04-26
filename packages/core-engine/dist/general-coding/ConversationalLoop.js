"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationalLoop = void 0;
// ─────────────────────────────────────────────────────────────────────────────
class ConversationalLoop {
    agent;
    planner;
    applicator;
    verifier;
    indexer;
    sessions;
    eventBus;
    interventions;
    contextStore;
    memorySystem;
    userProfileStore;
    preferenceNudge;
    budgetEnforcer;
    static MAX_VERIFY_ITERATIONS = 3;
    constructor(agent, planner, applicator, verifier, indexer, sessions, eventBus, interventions, contextStore, memorySystem, userProfileStore, preferenceNudge, budgetEnforcer) {
        this.agent = agent;
        this.planner = planner;
        this.applicator = applicator;
        this.verifier = verifier;
        this.indexer = indexer;
        this.sessions = sessions;
        this.eventBus = eventBus;
        this.interventions = interventions;
        this.contextStore = contextStore;
        this.memorySystem = memorySystem;
        this.userProfileStore = userProfileStore;
        this.preferenceNudge = preferenceNudge;
        this.budgetEnforcer = budgetEnforcer;
    }
    /**
     * planTurn — produces an EditPlan from the task goal without executing anything.
     * The plan is published as a 'plan-ready' event and execution is blocked until
     * the user approves via `oweibo approve <taskId>` (TaskInterventionGateway).
     *
     * G11: plan-before-execute surface — users see exactly what will change before it happens.
     *
     * Gap 4 + Gap 10 fix: `onPlanBuilt` optional callback is invoked AFTER EditPlanner
     * returns and BEFORE plan-ready is emitted. GeneralCodingOrchestrator.handle() passes
     * `stampSpecialistRoles()` here so that every initial DAG node has its `specialistRole`
     * set before the user sees the approval prompt. This is the minimal-change approach:
     * planTurn() remains the single place that emits plan-ready; the stamping is injected
     * from outside without touching EditPlanner's constructor or signature.
     */
    async planTurn(task, repoMapText, projectRules, skillsPrefix, // NEW v9.4 — after projectRules, before collectionName
    collectionName, secCtx, trace, onPlanBuilt) {
        const plan = await this.planner.plan(task.goal.description, repoMapText, collectionName);
        // Gap 4 + Gap 10: stamp specialist roles BEFORE emitting plan-ready
        onPlanBuilt?.(plan);
        // v9.5: plan is now a DAG — surface the full node graph in the plan-ready payload
        // so users see the dependency structure (and specialist roles) before approving execution.
        await this.eventBus.publish(task.sessionId ?? task.id, {
            taskId: task.id,
            type: 'plan-ready',
            message: `Ready to edit ${plan.filesToChange.length} file(s) across ${plan.nodes.length} node(s). Approve to proceed.`,
            payload: { plan }, // includes nodes[], dependsOn graph, estimatedComplexity, specialistRoles
        });
        // Persist DAG so worker restarts can re-surface the approval request
        await this.contextStore.save({
            id: `gc-plan:${task.id}`,
            status: 'awaiting-approval',
            plan,
        });
        // Block until user sends 'approve' intervention — uses existing pause/resume mechanism
        const intervention = await this.interventions.waitForApproval(task.id);
        if (intervention?.type === 'cancel') {
            throw new Error(`[ConversationalLoop] Task ${task.id} cancelled by user before edit began`);
        }
        await this.contextStore.save({ id: `gc-plan:${task.id}`, status: 'approved', plan });
        return plan;
    }
    /**
     * runTurns — executes the approved EditPlan through the edit → verify → fix loop.
     * Persists turn state so a worker restart resumes from the correct iteration.
     */
    async runTurns(task, plan, repoMapText, projectRules, skillsPrefix, // NEW v9.4
    collectionName, secCtx, trace, sessionId) {
        // Load user profile for prompt assembly (used by PromptBudgetEnforcer downstream).
        const userProfile = task.userId
            ? this.userProfileStore.renderProfile(await this.userProfileStore.loadProfile(task.tenantId, task.userId))
            : '';
        // budgetEnforcer is available for callers who need to assemble a budgeted prompt;
        // userProfile is captured here so it flows into the first enforce() call.
        void userProfile;
        void this.budgetEnforcer;
        const appliedEdits = [];
        let tokensUsed = 0;
        try {
            for (let iteration = 0; iteration < ConversationalLoop.MAX_VERIFY_ITERATIONS; iteration++) {
                await this.contextStore.save({ id: `gc-session:${task.id}`, status: 'running', turnIndex: iteration });
                // 1. Semantic search for relevant context
                const context = await this.indexer.search(collectionName, plan.instruction, 10);
                // 2. Read current file contents for files in plan
                const fileContents = await this.readFiles(plan.filesToChange, task.repoPath);
                // 3. Generate proposal — streams 'edit-proposed' chunks via TaskEventBus (G13)
                await this.eventBus.publish(sessionId, {
                    taskId: task.id,
                    type: 'stage-started',
                    message: `Generating edits (attempt ${iteration + 1})…`,
                    progress: 30 + iteration * 20,
                });
                const proposal = await this.agent.proposeEdit(plan.instruction, fileContents, context, (chunk, fileHint) => {
                    void this.eventBus.publish(sessionId, {
                        taskId: task.id,
                        type: 'edit-proposed',
                        message: fileHint ? `Editing ${fileHint}…` : 'Generating edits…',
                        payload: { chunk, fileHint },
                    });
                });
                tokensUsed += proposal.proposal.length * 800; // approximate
                // 4. Apply changes atomically via git
                const { commitHash, editedFiles } = await this.applicator.apply(task.repoPath, proposal, task.id, sessionId);
                appliedEdits.push(...editedFiles);
                await this.eventBus.publish(sessionId, {
                    taskId: task.id,
                    type: 'edit-applied',
                    message: `Changes applied to ${editedFiles.length} file(s).`,
                    payload: { commitHash, files: editedFiles },
                });
                // 5. Verify — tsc → eslint → targeted jest (G4)
                const verifyResult = await this.verifier.run(task.repoPath, editedFiles, secCtx);
                if (verifyResult.passed) {
                    await this.contextStore.save({ id: `gc-session:${task.id}`, status: 'complete', turnIndex: iteration });
                    await this.sessions.appendTask(sessionId, task.userId ?? '', {
                        taskId: task.id,
                        goal: plan.instruction,
                        outcome: 'success',
                        keyDecisions: [`edited: ${editedFiles.join(', ')}`, `commit: ${commitHash}`],
                        deliveredAt: new Date().toISOString(),
                    });
                    // Persist turn memory and check for preference signals.
                    await this.memorySystem.store({
                        tenantId: task.tenantId,
                        userId: task.userId,
                        sessionId,
                        scope: `session:${sessionId}`,
                        type: 'successful-strategy',
                        tier: 'episodic',
                        summary: `Applied edits to ${editedFiles.join(', ')} — verification passed`,
                        detail: { commitHash, editedFiles, iteration },
                        relevanceTags: ['general-coding', 'edit'],
                    });
                    await this.preferenceNudge.maybeNudge({
                        tenantId: task.tenantId,
                        userId: task.userId,
                        sessionId,
                        turnIndex: iteration,
                    });
                    return { status: 'success', appliedEdits, commitHash, verificationPassed: true, tokensUsed };
                }
                // 6. Verification failed — feed errors back into next iteration
                await this.eventBus.publish(sessionId, {
                    taskId: task.id,
                    type: 'verification-failed',
                    message: `Verification found ${verifyResult.errors.length} error(s). Attempting fix…`,
                    payload: { errors: verifyResult.errors },
                });
                plan = { ...plan, instruction: `${plan.instruction}\n\nFix the following errors:\n${verifyResult.errors.join('\n')}` };
            }
            await this.eventBus.publish(sessionId, {
                taskId: task.id,
                type: 'hitl-required',
                message: 'Could not automatically fix all verification errors. Human review required.',
                payload: {},
            });
            return { status: 'partial', appliedEdits, verificationPassed: false, tokensUsed };
        }
        finally {
            // Always tear down the session — destroySession is idempotent and non-throwing.
            await this.memorySystem.endSession(task.tenantId, sessionId);
        }
    }
    async readFiles(paths, repoRoot) {
        const { readFile } = await import('fs/promises');
        const { join } = await import('path');
        const entries = await Promise.all(paths.map(async (p) => [p, await readFile(join(repoRoot, p), 'utf8')]));
        return Object.fromEntries(entries);
    }
}
exports.ConversationalLoop = ConversationalLoop;
//# sourceMappingURL=ConversationalLoop.js.map