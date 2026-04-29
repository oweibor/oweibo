/**
 * Task 5.7 & 5.8: Staging API.
 * GET  /staging              → Lists pending items (decisions from FS + invariants from Qdrant)
 * POST /staging/:id/approve  → Promote item to active memory
 * POST /staging/:id/reject   → Move item to rejected
 *
 * Invariant staging entries live in Qdrant project_invariants (status:'staging').
 * Decision staging entries live in .kilo/staging/ on the filesystem.
 * The approve route handles both sources transparently.
 *
 * All routes require auth.  Workspace path is derived from the authenticated
 * tenantId — clients can no longer pass `workspace` or `tenant_id` from the
 * request body or query string (this used to allow cross-tenant reads).
 *
 * @module routes/staging
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../services/logger');
const promotionEngine = require('../services/promotion/engine');
const qdrant = require('../services/qdrant');
const { safeJoin, sanitizeSegment } = require('../services/safePath');
const { authenticate, requireScopes, buildLegacyTokenMap } = require('@oweibo/api-middleware');

const router = express.Router();

/**
 * Resolve the tenant's staging directory.  Used by every handler in this file
 * — staging items live under the tenant's workspace, never under a caller-
 * supplied workspace path.
 *
 * Workspace root layout:
 *   <WORKSPACE_ROOT>/<tenantId>/.kilo/staging
 *   <WORKSPACE_ROOT>/<tenantId>/.kilo/rejected
 *
 * @paramtenantId  - sanitized tenant id (caller is responsible)
 * @paramsubdir    - 'staging' or 'rejected'
 */
function tenantKiloDir(tenantId, subdir) {
    return safeJoin(
        config.WORKSPACE_ROOT,
        sanitizeSegment(tenantId),
        '.kilo',
        sanitizeSegment(subdir)
    );
}

/**
 * GET /staging — list pending staging items for the caller's tenant.
 * Decisions come from <tenant>/.kilo/staging/ on the filesystem.
 * Invariants come from Qdrant project_invariants with status:'staging' AND
 * tenant_id matching the JWT's tenantId.
 */
const _auth = authenticate({ jwksUri: config.IDENTITY_JWKS_URI, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }, buildLegacyTokenMap());

router.get('/', _auth, requireScopes('staging:read'), async (req, res) => {
    const tenantId = (req as any).principal?.ctx?.tenantId || (req as any).tenantId;
    const items = [];

    // ── Decisions from filesystem (tenant-scoped) ──────────────────────────────
    let stagingDir;
    try {
        stagingDir = tenantKiloDir(tenantId, 'staging');
    } catch (err) {
        return res.status(400).json({ error: 'Bad Request', message: (err as Error).message });
    }

    if (fs.existsSync(stagingDir)) {
        try {
            const files = fs.readdirSync(stagingDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const raw = fs.readFileSync(path.join(stagingDir, f), 'utf8');
                    items.push(JSON.parse(raw));
                } catch (parseErr) {
                    logger.warn('staging GET: failed to parse file', { file: f, error: parseErr.message });
                }
            }
        } catch (err) {
            logger.error('staging GET: failed to read staging dir', { error: err.message });
        }
    }

    // ── Invariants from Qdrant (always tenant-scoped) ──────────────────────────
    try {
        const filter = {
            must: [
                { key: 'status',    match: { value: 'staging' } },
                { key: 'tenant_id', match: { value: tenantId  } },
            ],
        };

        let offset = null;
        do {
            const result = await qdrant.scroll('project_invariants', {
                with_payload: true,
                limit: 100,
                filter,
                ...(offset != null ? { offset } : {}),
            });
            for (const point of result.points) {
                items.push({ id: point.id, ...point.payload });
            }
            offset = result.next_page_offset ?? null;
        } while (offset != null);
    } catch (err) {
        logger.warn('staging GET: Qdrant scroll failed — invariants omitted', { error: err.message });
    }

    items.sort((a, b) => (b.corroboration_count || 1) - (a.corroboration_count || 1));
    res.json(items);
});

/**
 * POST /staging/:id/approve
 * Promote a staging item to active memory.  Tenant-scoped: looks up the item
 * in <tenant>/.kilo/staging/ first, then Qdrant with a tenant filter.
 */
router.post('/:id/approve', _auth, requireScopes('staging:approve'), async (req, res) => {
    const tenantId = (req as any).principal?.ctx?.tenantId || (req as any).tenantId;

    let id;
    let stagingPath;
    let workspacePath;
    try {
        id = sanitizeSegment(req.params.id);
        workspacePath = safeJoin(config.WORKSPACE_ROOT, sanitizeSegment(tenantId));
        stagingPath = path.join(tenantKiloDir(tenantId, 'staging'), `${id}.json`);
    } catch (err) {
        return res.status(400).json({ error: 'Bad Request', message: (err as Error).message });
    }

    let item = null;
    let source = null;

    if (fs.existsSync(stagingPath)) {
        try {
            item = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
            source = 'filesystem';
        } catch (err) {
            logger.error('staging approve: failed to read staging item', { id, error: err.message });
            return res.status(500).json({ error: 'Failed to read staging item' });
        }
    } else {
        // Try Qdrant — must include tenant filter
        try {
            const filter = {
                must: [
                    { key: 'id',        match: { value: id } },
                    { key: 'status',    match: { value: 'staging' } },
                    { key: 'tenant_id', match: { value: tenantId } },
                ],
            };
            const result = await qdrant.scroll('project_invariants', {
                with_payload: true,
                limit: 1,
                filter,
            });
            if (result.points.length > 0) {
                item = { id: result.points[0].id, ...result.points[0].payload };
                source = 'qdrant';
            }
        } catch (err) {
            logger.error('staging approve: Qdrant lookup failed', { id, error: err.message });
        }
    }

    if (!item) {
        return res.status(404).json({ error: 'Staging item not found' });
    }

    try {
        const success = await promotionEngine.promoteItem(item, workspacePath);

        if (!success) {
            return res.status(500).json({ error: 'Failed to promote item' });
        }

        res.json({
            status: 'approved',
            source,
            promoted_to: item.type === 'decision' ? 'project_decisions' : 'project_invariants',
            qdrant_updated: true,
        });
    } catch (err) {
        logger.error('staging approve error', { id, error: err.message });
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /staging/:id/reject
 * Move item from staging to rejected.  Tenant-scoped.
 */
router.post('/:id/reject', _auth, requireScopes('staging:reject'), async (req, res) => {
    const tenantId = (req as any).principal?.ctx?.tenantId || (req as any).tenantId;
    const { reason = 'Manual rejection' } = req.body || {};

    let id;
    let stagingPath;
    let rejectedDir;
    try {
        id = sanitizeSegment(req.params.id);
        stagingPath = path.join(tenantKiloDir(tenantId, 'staging'), `${id}.json`);
        rejectedDir = tenantKiloDir(tenantId, 'rejected');
    } catch (err) {
        return res.status(400).json({ error: 'Bad Request', message: (err as Error).message });
    }

    let item = null;
    let source = null;

    if (fs.existsSync(stagingPath)) {
        try {
            item = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
            source = 'filesystem';
        } catch (err) {
            logger.error('staging reject: failed to read staging item', { id, error: err.message });
            return res.status(500).json({ error: 'Failed to read staging item' });
        }
    } else {
        try {
            const filter = {
                must: [
                    { key: 'id',        match: { value: id } },
                    { key: 'status',    match: { value: 'staging' } },
                    { key: 'tenant_id', match: { value: tenantId } },
                ],
            };
            const result = await qdrant.scroll('project_invariants', {
                with_payload: true,
                limit: 1,
                filter,
            });
            if (result.points.length > 0) {
                item = { id: result.points[0].id, ...result.points[0].payload };
                source = 'qdrant';
            }
        } catch (err) {
            logger.warn('staging reject: Qdrant lookup failed', { id, error: err.message });
        }
    }

    if (!item) {
        return res.status(404).json({ error: 'Staging item not found' });
    }

    try {
        fs.mkdirSync(rejectedDir, { recursive: true });
        item.rejected_at = new Date().toISOString();
        item.rejection_reason = reason;
        fs.writeFileSync(path.join(rejectedDir, `${id}.json`), JSON.stringify(item, null, 2));

        if (source === 'filesystem') {
            fs.unlinkSync(stagingPath);
        } else {
            await qdrant.delete('project_invariants', {
                filter: {
                    must: [
                        { key: 'id',        match: { value: id } },
                        { key: 'tenant_id', match: { value: tenantId } },
                    ],
                },
            });
        }

        logger.info('Staging item rejected manually', { id, reason, source, tenant_id: tenantId });
        res.json({ status: 'rejected', id });

    } catch (err) {
        logger.error('staging reject error', { id, error: err.message });
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;

export {};
