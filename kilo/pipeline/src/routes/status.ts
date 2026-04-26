/**
 * GET /status/:task_id — Return task state from memory + checkpoint.
 *
 * Requires a valid Bearer token (authMiddleware); `req.tenantId` is injected.
 * Tasks belonging to a different tenant return 404 (not 403) to prevent
 * enumeration of other tenants' task IDs.
 *
 * @module routes/status
 */

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const config         = require('../config');
const authMiddleware = require('../middleware/auth');
const { safeJoin, sanitizeSegment } = require('../services/safePath');
const queue          = require('../services/queue');
const logger         = require('../services/logger');

const router = Router();

router.get('/status/:task_id', authMiddleware, (req, res) => {
    const { task_id } = req.params;
    const { tenantId } = req;

    // --- Check in-memory queue first ---
    const task = queue.get(task_id);

    if (task) {
        // Tenant isolation: return 404 if task belongs to a different tenant
        if (task.tenant_id !== tenantId) {
            logger.warn('Status request for foreign task', {
                task_id,
                tenant_id: tenantId,
                owner_tenant_id: task.tenant_id,
            });
            return res.status(404).json({ error: 'Not Found', message: `Task ${task_id} not found` });
        }

        return res.json({
            task_id:       task.task_id,
            tenant_id:     task.tenant_id,
            status:        task.status,
            current_stage: task.current_stage,
            started_at:    task.started_at,
            updated_at:    task.updated_at,
            result:        task.result,
        });
    }

    // --- Fall back to tenant-scoped checkpoint ---
    // Checkpoints are stored under CHECKPOINT_DIR/<tenantId>/<task_id>/state.json
    let statePath: string;
    try {
        statePath = path.join(
            safeJoin(config.CHECKPOINT_DIR, sanitizeSegment(tenantId), sanitizeSegment(task_id)),
            'state.json'
        );
    } catch {
        return res.status(400).json({ error: 'Bad Request', message: 'Invalid task_id or tenant_id' });
    }

    if (fs.existsSync(statePath)) {
        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

            // Double-check tenant ownership embedded in the checkpoint
            if (state.tenant_id && state.tenant_id !== tenantId) {
                logger.warn('Checkpoint tenant mismatch', {
                    task_id,
                    tenant_id: tenantId,
                    checkpoint_tenant_id: state.tenant_id,
                });
                return res.status(404).json({ error: 'Not Found', message: `Task ${task_id} not found` });
            }

            return res.json({
                task_id:       state.task_id,
                tenant_id:     state.tenant_id,
                status:        state.status,
                current_stage: state.current_stage,
                started_at:    state.started_at,
                updated_at:    state.updated_at,
                result:        state.result,
                source:        'checkpoint',
            });
        } catch {
            return res.status(500).json({
                error: 'Internal Server Error',
                message: 'Failed to read checkpoint state',
            });
        }
    }

    return res.status(404).json({ error: 'Not Found', message: `Task ${task_id} not found` });
});

module.exports = router;

export {};
