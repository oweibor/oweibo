/**
 * Kilo CLI execution wrappers.
 * Runs `kilo architect` and `kilo orchestrate` inside Docker sandboxes.
 *
 * @module services/executor
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const sandbox = require('./sandbox');
const workspaceDiff = require('./recovery/workspaceDiff');
const logger = require('./logger');
const { safeJoin, sanitizeSegment } = require('./safePath');

/**
 * Run `kilo architect` — generates an architecture plan from the instruction.
 *
 * @paramtaskId
 * @paraminstruction
 * @parammemoryContext - Memory context block
 * @paramworkspacePath
 * @param[opts]
 * @param[opts.memoryAdapter]   - PipelineMemoryAdapter for LTM stage writes
 * @param[opts.tenantId]
 * @param[opts.workingMemory]   - Tier-1 scratchpad bucket; receives stage output under 'stages.architect'
 * @returns
 */
async function runArchitect(taskId, instruction, memoryContext, workspacePath, opts = {} as any) {
    const { memoryAdapter, tenantId, workingMemory } = opts;
    const checkpointDir = safeJoin(config.CHECKPOINT_DIR, sanitizeSegment(taskId));

    logger.info('Running kilo architect', { task_id: taskId });

    // Spawn sandbox
    const { containerId } = await sandbox.spawnSandbox(
        taskId,
        workspacePath,
        instruction,
        memoryContext
    );

    try {
        // Install kilo CLI inside sandbox (argv — no shell interpretation)
        const installResult = await sandbox.execInSandbox(containerId, [
            'npm', 'install', '-g', '@kilocode/cli',
        ]);

        if (installResult.exitCode !== 0) {
            logger.error('kilo CLI install failed', {
                task_id: taskId,
                stderr: installResult.stderr,
            });
        }

        // Run kilo architect — instruction passed as discrete argv token; no shell involved
        const result = await sandbox.execInSandbox(containerId, [
            'kilo', 'architect',
            '--instruction',  instruction,
            '--context-file', '/checkpoint/memory_context.md',
            '--output',       '/checkpoint/architecture_plan.md',
        ]);

        // Save stdout/stderr to logs
        const logPath = path.join(checkpointDir, 'architect.log');
        fs.writeFileSync(logPath, `EXIT CODE: ${result.exitCode}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`);

        // Read architecture plan if it was generated
        let plan = '';
        const planPath = path.join(checkpointDir, 'architecture_plan.md');
        if (fs.existsSync(planPath)) {
            plan = fs.readFileSync(planPath, 'utf8');
        }

        logger.info('kilo architect completed', {
            task_id: taskId,
            exit_code: result.exitCode,
            plan_length: plan.length,
        });

        // P-5: write stage boundary to memory so downstream stages can recall context
        if (memoryAdapter && tenantId) {
            await memoryAdapter.storeStageOutput({
                tenantId,
                taskId,
                stage:   'architect',
                summary: `Architecture plan generated (${plan.length} chars, exit ${result.exitCode}): ${plan.slice(0, 200)}`,
                detail:  { planLength: plan.length, exitCode: result.exitCode },
            });
        }

        // Tier-1 scratchpad: publish stage output for downstream stages to read
        // without needing it threaded through return values or opts bags.
        if (workingMemory) {
            workingMemory.set('stages.architect', {
                plan,
                exitCode:    result.exitCode,
                planLength:  plan.length,
                completedAt: new Date().toISOString(),
            });
        }

        return { plan, exitCode: result.exitCode };
    } finally {
        await sandbox.cleanupSandbox(containerId);
    }
}

/**
 * Run `kilo orchestrate` — executes the plan against the workspace.
 * Routes based on exit code:
 *   0 → gates (Stage 8)
 *   1 → error recovery (Stage 1 — canonicalization)
 *   2 → convergence (Stage 7)
 *
 * @paramtaskId
 * @paramworkspacePath
 * @param[opts]
 * @param[opts.memoryAdapter]  - PipelineMemoryAdapter for LTM stage writes
 * @param[opts.tenantId]
 * @param[opts.workingMemory]  - Tier-1 scratchpad bucket; receives stage output under 'stages.orchestrate'
 * @returns
 */
async function runOrchestrate(taskId, workspacePath, opts = {} as any) {
    const { memoryAdapter, tenantId, workingMemory } = opts;
    const checkpointDir = safeJoin(config.CHECKPOINT_DIR, sanitizeSegment(taskId));
    const planPath = path.join(checkpointDir, 'architecture_plan.md');

    if (!fs.existsSync(planPath)) {
        throw new Error(`architecture_plan.md not found for task ${taskId}`);
    }

    logger.info('Running kilo orchestrate', { task_id: taskId });

    // Spawn sandbox with the workspace
    const memoryContext = ''; // Already embedded in the plan
    const { containerId } = await sandbox.spawnSandbox(
        taskId,
        workspacePath,
        'orchestrate',
        memoryContext
    );

    try {
        // Install kilo CLI (argv — no shell)
        await sandbox.execInSandbox(containerId, [
            'npm', 'install', '-g', '@kilocode/cli',
        ]);

        // Run kilo orchestrate — exit code read from Docker exec inspect, not stdout
        const result = await sandbox.execInSandbox(containerId, [
            'kilo', 'orchestrate',
            '--plan',      '/checkpoint/architecture_plan.md',
            '--workspace', '/workspace',
        ]);

        // Exit code comes directly from Docker exec inspect (sandbox.execInSandbox
        // already resolves ExitCode via exec.inspect()).
        let exitCode = result.exitCode;

        // Route based on exit code
        let route;
        switch (exitCode) {
            case 0:
                route = 'gates'; // Stage 8 — semantic guard
                break;
            case 1:
                route = 'error_recovery'; // Stage 1 — canonicalization
                break;
            case 2:
                route = 'convergence'; // Stage 7 — convergence check
                break;
            default:
                route = 'error_recovery'; // Unknown → treat as error
                break;
        }

        // Save logs
        const logPath = path.join(checkpointDir, 'orchestrator.log');
        fs.writeFileSync(logPath, [
            `EXIT CODE: ${exitCode}`,
            `ROUTE: ${route}`,
            '',
            'STDOUT:',
            result.stdout,
            '',
            'STDERR:',
            result.stderr,
        ].join('\n'));

        logger.info('kilo orchestrate completed', {
            task_id: taskId,
            exit_code: exitCode,
            route,
        });

        // Diff the workspace while the container is still alive
        let changedFiles = [];
        try {
            ({ changedFiles } = await workspaceDiff.diffWorkspace(taskId, containerId, 1));
        } catch (diffErr) {
            logger.warn('Workspace diff failed — gate scope will be empty', { task_id: taskId, error: diffErr.message });
        }

        // P-5: write orchestrate stage boundary to memory
        if (memoryAdapter && tenantId) {
            await memoryAdapter.storeStageOutput({
                tenantId,
                taskId,
                stage:   'orchestrate',
                summary: `Orchestration routed to '${route}' (exit ${exitCode})`,
                detail:  { route, exitCode, changedFileCount: Object.keys(changedFiles || {}).length },
            });
        }

        // Tier-1 scratchpad: publish orchestrate output for gates / writers / recovery.
        // stdout & stderr are NOT mirrored into wm — they can be megabytes; consumers
        // that need them should still read from orchResult or the on-disk log.
        if (workingMemory) {
            workingMemory.set('stages.orchestrate', {
                exitCode,
                route,
                changedFiles,
                changedFileCount: Object.keys(changedFiles || {}).length,
                completedAt:      new Date().toISOString(),
            });
        }

        return { exitCode, route, stdout: result.stdout, stderr: result.stderr, changedFiles };
    } finally {
        await sandbox.cleanupSandbox(containerId);
    }
}

module.exports = { runArchitect, runOrchestrate };

export {};
