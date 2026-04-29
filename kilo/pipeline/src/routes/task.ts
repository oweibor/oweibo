/**
 * POST /task        — Accept a task from an API client.
 * POST /task/clear  — Unblock a supervised-mode blocked task.
 *
 * All routes require a valid Bearer token (authMiddleware) which injects
 * `req.tenantId`.  Task ownership is verified on every mutating operation.
 *
 * @module routes/task
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');
const config         = require('../config');
const { taskLimiter } = require('../middleware/rateLimiter');
const { validate, TASK_SCHEMA, TASK_CLEAR_SCHEMA } = require('../middleware/validate');
const { safeJoin, sanitizeSegment } = require('../services/safePath');
const queue          = require('../services/queue');
const logger         = require('../services/logger');
const ledger         = require('../services/recovery/ledger');
const { authenticate, requireScopes, buildLegacyTokenMap, idempotent } = require('@oweibo/api-middleware');
const { checkAndConsume } = require('../services/quota');

/**
 * Read gate_results.json for a task and penalise any invariants that blocked it.
 * Called whenever a human explicitly overrides a supervised-mode gate failure.
 * Non-fatal: errors are logged and swallowed so they never block unblocking the task.
 *
 * @paramtaskId
 * @paramtenantId
 */
async function _penaliseGateFailedInvariants(taskId, tenantId) {
    try {
        const gateResultsPath = path.join(
            config.CHECKPOINT_DIR, tenantId || 'default', taskId, 'gate_results.json'
        );
        if (!fs.existsSync(gateResultsPath)) return;

        const gateResults = JSON.parse(fs.readFileSync(gateResultsPath, 'utf8'));
        const failedIds = gateResults.failed_invariant_ids || [];
        if (failedIds.length === 0) return;

        const memoryAdapter = require('../services/pipelineMemoryAdapter');
        await Promise.allSettled(
            failedIds.map(id => memoryAdapter.penalise(id, tenantId))
        );
        logger.info('task/clear: penalised gate-failed invariants (human override)', {
            task_id: taskId, count: failedIds.length,
        });
    } catch (err) {
        logger.warn('task/clear: false-positive tracking failed (non-fatal)', {
            task_id: taskId, error: err.message,
        });
    }
}

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and validate that `workspacePath` is a child of
 * `<WORKSPACE_ROOT>/<tenantId>/`.  Returns the resolved absolute path on
 * success, or throws an Error with a safe message on failure.
 *
 * The double path.resolve prevents path-traversal attacks:
 *   - First resolve: canonicalise the client-supplied path (removes ../…)
 *   - Prefix check: ensure it starts with the tenant root
 *
 * @paramtenantId
 * @paramworkspacePath
 * @returnsresolved absolute path
 */
function validateWorkspacePath(tenantId, workspacePath) {
    // Each tenant is restricted to its own subdirectory.
    const tenantRoot = path.resolve(config.WORKSPACE_ROOT, tenantId);
    const resolved   = path.resolve(workspacePath);

    // resolved must start with tenantRoot + path.sep (or equal tenantRoot)
    if (resolved !== tenantRoot && !resolved.startsWith(tenantRoot + path.sep)) {
        throw Object.assign(
            new Error(`workspace_path must be inside ${tenantRoot}`),
            { statusCode: 403 }
        );
    }

    return resolved;
}

// ---------------------------------------------------------------------------
// POST /task
// ---------------------------------------------------------------------------

router.post('/task',
    authenticate({ jwksUri: config.IDENTITY_JWKS_URI, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }, buildLegacyTokenMap()),
    requireScopes('tasks:write'),
    taskLimiter,
    validate(TASK_SCHEMA),
    async (req, res) => {
    const tenantId = (req as any).principal?.ctx?.tenantId || (req as any).tenantId;
    const { workspace_path, instruction, trust_mode_override } = req.body;

    // --- Validate required fields ---
    if (!workspace_path || !instruction) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'workspace_path and instruction are required',
        });
    }

    // --- Enforce workspace isolation ---
    let resolvedWorkspace;
    try {
        resolvedWorkspace = validateWorkspacePath(tenantId, workspace_path);
    } catch (err) {
        logger.warn('workspace_path rejected', {
            tenant_id: tenantId,
            workspace_path,
            reason: err.message,
        });
        return res.status((err as any).statusCode || 400).json({
            error: (err as any).statusCode === 403 ? 'Forbidden' : 'Bad Request',
            message: err.message,
        });
    }

    // --- Trust mode ---
    const trust_mode = trust_mode_override || config.TRUST_MODE;
    if (!['supervised', 'graduated', 'autonomous'].includes(trust_mode)) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'trust_mode_override must be supervised|graduated|autonomous',
        });
    }

    // --- Generate or accept caller-supplied task_id ---
    // Caller-supplied IDs are already validated by TASK_SCHEMA (alphanumeric/hyphen/underscore only).
    const task_id = req.body.task_id || uuidv4();

    // --- Quota check (daily tasks cap) ---
    const quota = await checkAndConsume(tenantId, 'tasks_day');
    if (!quota.allowed) {
        return res.status(429).json({
            error: 'quota_exceeded',
            message: 'Daily task quota exceeded',
            current: quota.current,
        });
    }

    try {
        const result = queue.enqueue({
            task_id,
            tenant_id: tenantId,
            workspace_path: resolvedWorkspace,
            instruction,
            trust_mode,
        });

        // Persist initial checkpoint (scoped to tenantId/task_id).
        // Both segments have been validated above — safeJoin adds a defence-in-depth check.
        const checkpointDir = safeJoin(
            config.CHECKPOINT_DIR,
            sanitizeSegment(tenantId),
            sanitizeSegment(task_id)
        );
        fs.mkdirSync(checkpointDir, { recursive: true });
        fs.writeFileSync(
            path.join(checkpointDir, 'state.json'),
            JSON.stringify(queue.get(task_id), null, 2)
        );

        logger.info('Task accepted', {
            task_id,
            tenant_id: tenantId,
            workspace_path: resolvedWorkspace,
            trust_mode,
        });

        return res.status(202).json(result);
    } catch (err) {
        if ((err as any).statusCode === 409) {
            return res.status(409).json({ error: 'Conflict', message: err.message });
        }
        logger.error('Failed to enqueue task', { task_id, tenant_id: tenantId, error: err.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ---------------------------------------------------------------------------
// POST /task/clear
// ---------------------------------------------------------------------------

router.post('/task/clear',
    authenticate({ jwksUri: config.IDENTITY_JWKS_URI, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }, buildLegacyTokenMap()),
    requireScopes('tasks:write'),
    validate(TASK_CLEAR_SCHEMA), (req, res) => {
    const tenantId = (req as any).principal?.ctx?.tenantId || (req as any).tenantId;
    const { task_id, action, guidance, hash } = req.body;

    if (!task_id) {
        return res.status(400).json({ error: 'Bad Request', message: 'task_id is required' });
    }

    // --- Ownership check ---
    const task = queue.get(task_id);
    if (task && task.tenant_id !== tenantId) {
        logger.warn('Task ownership mismatch on /task/clear', {
            task_id,
            tenant_id: tenantId,
            owner_tenant_id: task.tenant_id,
        });
        // Return 404 rather than 403 to avoid enumeration
        return res.status(404).json({ error: 'Not Found', message: `Task ${task_id} not found` });
    }

    if (!action) {
        // Legacy /task/clear without action field — human override of any gate failure
        const unblocked = queue.clearBlock(task_id);
        if (!unblocked) {
            return res.status(404).json({
                error: 'Not Found',
                message: `Task ${task_id} not found or not in blocked state`,
            });
        }
        // Fire-and-forget: penalise invariants that caused the block
        _penaliseGateFailedInvariants(task_id, tenantId).catch(() => {});
        logger.info('Task unblocked via legacy /task/clear', { task_id, tenant_id: tenantId });
        return res.status(200).json({ task_id, status: 'queued', message: 'Task unblocked (legacy)' });
    }

    switch (action) {
        case 'provide_guidance': {
            const t = queue.get(task_id);
            if (!t || t.status !== 'blocked') {
                return res.status(404).json({ error: 'Not Found', message: `Task ${task_id} not blocked` });
            }
            if (guidance) {
                t.guidance = t.guidance ? [...t.guidance, guidance] : [guidance];
            }
            queue.clearBlock(task_id);
            // Human explicitly overriding a gate block — penalise the blocking invariants
            _penaliseGateFailedInvariants(task_id, tenantId).catch(() => {});
            logger.info('Task unblocked with guidance', { task_id, tenant_id: tenantId });
            return res.status(200).json({ task_id, status: 'queued', message: 'Task resumed with guidance' });
        }

        case 'mark_permanent': {
            if (!hash) return res.status(400).json({ error: 'Bad Request', message: 'hash is required' });
            // Tenant-scoped: mark_permanent against tenant A's ledger does NOT
            // affect tenant B's recovery decisions for the same canonical hash.
            const entry = ledger.getLedgerEntry(hash, {
                error_type: 'forced_failure',
                canonical_key: 'manual',
                calling_function: 'manual',
            }, tenantId);
            entry.seen_count  = 999;
            entry.staleness_flag = false;
            entry.ttl_days    = 999;
            ledger.saveLedgerEntry(entry, tenantId);

            const t = queue.get(task_id);
            if (t && t.status === 'blocked') {
                queue.update(task_id, { result: { error: 'Marked permanent' } });
                queue.fail(task_id, 'Marked permanent');
            }
            logger.info('Ledger marked permanent', { hash, task_id, tenant_id: tenantId });
            return res.status(200).json({ task_id, message: 'Marked permanent' });
        }

        case 'reset_ledger': {
            if (!hash) return res.status(400).json({ error: 'Bad Request', message: 'hash is required' });
            // Tenant-scoped: only resets THIS tenant's entry for the hash.
            const success = ledger.resetLedger(hash, tenantId);
            if (!success) {
                return res.status(404).json({ error: 'Not Found', message: 'Ledger hash not found' });
            }
            const t = queue.get(task_id);
            if (t && t.status === 'blocked') {
                queue.clearBlock(task_id);
            }
            return res.status(200).json({ task_id, status: 'queued', message: 'Ledger reset and task resumed' });
        }

        default:
            return res.status(400).json({ error: 'Bad Request', message: `Unknown action: ${action}` });
    }
});

module.exports = router;

export {};
