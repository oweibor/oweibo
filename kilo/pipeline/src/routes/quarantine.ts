/**
 * Task 5.9: Quarantine API.
 * GET  /quarantine               -> Lists active quarantined items for the caller's tenant.
 * POST /quarantine/:id/override  -> Promote or Dismiss a quarantined item.
 *
 * Quarantine items must include a `tenant_id` field in their JSON payload.
 * Items without one are considered legacy/global and visible to no-one (until
 * a backfill migration assigns ownership in Phase 1).  This is fail-closed —
 * the alternative (showing untagged items to all tenants) was the original
 * leak.
 *
 * @module routes/quarantine
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const promotionEngine = require('../services/promotion/engine');
const config = require('../config');
const { sanitizeSegment } = require('../services/safePath');
const { authenticate, requireScopes, buildLegacyTokenMap } = require('@oweibo/api-middleware');

const router = express.Router();

const QUARANTINE_BASE = '/var/kilo/quarantine';
const SUBDIRS = ['tasks', 'invariants', 'decisions'];

/**
 * Find a quarantine item by id under any of the known subdirs.
 * The id must already be sanitized by the caller — we never let it influence
 * the path beyond a single basename component.  We also require the on-disk
 * filename to start with `${id}_` or equal `${id}.json` so a short or empty
 * id can't match the first file in the directory.
 */
function findQuarantineItem(id) {
    for (const sub of SUBDIRS) {
        const dir = path.join(QUARANTINE_BASE, sub);
        if (!fs.existsSync(dir)) continue;

        let files;
        try {
            files = fs.readdirSync(dir);
        } catch {
            continue;
        }

        const exact = `${id}.json`;
        const prefix = `${id}_`;
        const match = files.find(
            (f) => f === exact || (f.startsWith(prefix) && f.endsWith('.json'))
        );
        if (match) {
            return { itemPath: path.join(dir, match), subdir: sub };
        }
    }
    return null;
}

/**
 * Read and parse a quarantine JSON file.  Returns null on parse error.
 */
function readQuarantineFile(itemPath) {
    try {
        return JSON.parse(fs.readFileSync(itemPath, 'utf8'));
    } catch (err) {
        logger.warn('quarantine: failed to parse file', { itemPath, error: err.message });
        return null;
    }
}

/**
 * GET /quarantine — list quarantine items for the caller's tenant only.
 * Items lacking a `tenant_id` field are skipped (fail-closed; backfill in
 * Phase 1 platform migration).
 */
const _auth = authenticate({ jwksUri: config.IDENTITY_JWKS_URI, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }, buildLegacyTokenMap());

router.get('/', _auth, requireScopes('quarantine:read'), (req, res) => {
    const tenantId = (req as any).principal?.ctx?.tenantId || (req as any).tenantId;
    const allItems = [];

    if (!fs.existsSync(QUARANTINE_BASE)) {
        return res.json([]);
    }

    try {
        for (const sub of SUBDIRS) {
            const d = path.join(QUARANTINE_BASE, sub);
            if (!fs.existsSync(d)) continue;

            for (const file of fs.readdirSync(d).filter((f) => f.endsWith('.json'))) {
                const content = readQuarantineFile(path.join(d, file));
                if (!content) continue;
                if (content.tenant_id !== tenantId) continue;
                allItems.push({ ...content, quarantine_type: sub });
            }
        }
        res.json(allItems);
    } catch (err) {
        logger.error('Failed to read quarantine', { error: err.message });
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /quarantine/:id/override
 * Promote or dismiss a quarantined item.  Ownership enforced by tenant_id
 * embedded in the item — cross-tenant override returns 404 to avoid
 * enumeration.
 */
router.post('/:id/override', _auth, requireScopes('quarantine:override'), async (req, res) => {
    const tenantId = (req as any).principal?.ctx?.tenantId || (req as any).tenantId;
    const { action } = req.body || {}; // 'promote' or 'dismiss'

    let id;
    try {
        id = sanitizeSegment(req.params.id);
    } catch (err) {
        return res.status(400).json({ error: 'Bad Request', message: (err as Error).message });
    }

    const found = findQuarantineItem(id);
    if (!found) {
        return res.status(404).json({ error: 'Quarantine item not found' });
    }

    const item = readQuarantineFile(found.itemPath);
    if (!item) {
        return res.status(500).json({ error: 'Failed to read quarantine item' });
    }

    // Tenant ownership check — return 404 (not 403) to avoid enumeration
    if (item.tenant_id !== tenantId) {
        logger.warn('quarantine override: cross-tenant attempt', {
            id,
            caller_tenant_id: tenantId,
            owner_tenant_id: item.tenant_id || '<none>',
        });
        return res.status(404).json({ error: 'Quarantine item not found' });
    }

    // Workspace path is derived from the tenant — never accepted from the body.
    const config = require('../config');
    const { safeJoin } = require('../services/safePath');
    let workspacePath;
    try {
        workspacePath = safeJoin(config.WORKSPACE_ROOT, sanitizeSegment(tenantId));
    } catch (err) {
        return res.status(400).json({ error: 'Bad Request', message: (err as Error).message });
    }

    try {
        if (action === 'promote') {
            const success = await promotionEngine.promoteItem(item, workspacePath);
            if (success) {
                fs.unlinkSync(found.itemPath);
                return res.json({ status: 'overridden_promoted' });
            }
            return res.status(500).json({ error: 'Failed' });
        } else if (action === 'dismiss') {
            const dismissedDir = path.join(QUARANTINE_BASE, 'dismissed');
            fs.mkdirSync(dismissedDir, { recursive: true });
            fs.writeFileSync(
                path.join(dismissedDir, path.basename(found.itemPath)),
                JSON.stringify(item)
            );
            fs.unlinkSync(found.itemPath);
            return res.json({ status: 'dismissed' });
        } else {
            return res.status(400).json({ error: 'Action must be promote or dismiss' });
        }
    } catch (err) {
        logger.error('Quarantine override error', { id, error: err.message });
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;

export {};
