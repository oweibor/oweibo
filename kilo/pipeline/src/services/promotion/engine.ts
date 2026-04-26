/**
 * Task 5.6: Promotion Engine.
 * Periodically or per-task evaluates items in kilo/.kilo/staging/.
 * Auto-promotes items to active memory (Qdrant & project_decisions)
 * based on corroboration count and the active TRUST_MODE.
 *
 * Staging for invariants is stored exclusively in Qdrant project_invariants
 * with payload field status:'staging'. invariants.yaml is a read-only
 * human-inspection export; nothing in the pipeline writes to it at runtime.
 *
 * @module services/promotion/engine
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const config = require('../../config');
const qdrant = require('../qdrant');
const embeddings = require('../embeddings');

/**
 * Perform manual or automatic promotion of a staging item.
 *
 * @paramitem
 * @paramworkspacePath
 * @returns
 */
async function promoteItem(item, workspacePath) {
    try {
        const { type, id, title, rule, assertion_template, rationale, consequences, confidence, corroboration_count } = item;

        if (type === 'decision') {
            const decisionsDir = path.join(workspacePath, '.kilo', 'project_decisions');
            fs.mkdirSync(decisionsDir, { recursive: true });
            fs.writeFileSync(path.join(decisionsDir, `${id}.json`), JSON.stringify(item, null, 2));

            const decisionText = `${title}: ${rationale}`;
            const decisionVector = await embeddings.embed(decisionText);
            await qdrant.upsert('project_decisions', [{ id, vector: decisionVector, payload: item }]);
            logger.info('Promotion Engine: AUTO-PROMOTED Decision', { id, title });

        } else if (type === 'det_invariant' || type === 'sem_invariant') {
            const now = new Date().toISOString();
            const invariantText = type === 'sem_invariant' ? rule : assertion_template;
            const invariantVector = await embeddings.embed(invariantText);

            // Qdrant is the sole canonical write target. invariants.yaml is never
            // written at runtime — use `oweibo memory export-invariants` for inspection.
            const invariantPayload = {
                ...item,
                status: 'active',
                hit_count: 0,
                false_positive_count: 0,
                last_used_at: now,
                created_at: now,
            };
            await qdrant.upsert('project_invariants', [{ id, vector: invariantVector, payload: invariantPayload }]);
            logger.info(`Promotion Engine: AUTO-PROMOTED ${type}`, { id });
        }

        // Remove from staging: for decisions remove filesystem file;
        // for invariants the staging entry in Qdrant is replaced by the upsert above
        // (same ID, status flips to 'active').
        if (type === 'decision') {
            const stagingPath = path.join(workspacePath, '.kilo', 'staging', `${id}.json`);
            if (fs.existsSync(stagingPath)) {
                fs.unlinkSync(stagingPath);
            }
        }
        return true;

    } catch (err) {
        logger.error('Failed to promote item', { id: item.id, error: err.message });
        return false;
    }
}

/**
 * Scan staging and auto-promote eligible items based on TRUST_MODE.
 *
 * Decision-type staging items are read from the filesystem (.kilo/staging/).
 * Invariant-type staging items are read from Qdrant project_invariants with
 * payload filter status:'staging'.
 *
 * @paramworkspacePath
 * @param[tenantId] - Optional tenant filter for Qdrant invariant scroll
 */
async function evaluateStaging(workspacePath, tenantId) {
    logger.info('Promotion Engine evaluation started', { mode: config.TRUST_MODE });

    if (config.TRUST_MODE === 'supervised') {
        logger.debug('Supervised mode active — sweeping skipped (awaiting human approval)');
        return;
    }

    // ── Decisions: still stored on filesystem ──────────────────────────────────
    const stagingDir = path.join(workspacePath, '.kilo', 'staging');
    if (fs.existsSync(stagingDir)) {
        const files = fs.readdirSync(stagingDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const raw = fs.readFileSync(path.join(stagingDir, file), 'utf8');
            let item;
            try { item = JSON.parse(raw); } catch (e) { continue; }
            if (_shouldPromote(item)) {
                await promoteItem(item, workspacePath);
            }
        }
    }

    // ── Invariants: stored in Qdrant with status:'staging' ────────────────────
    try {
        const filter = {
            must: [{ key: 'status', match: { value: 'staging' } }],
        };
        if (tenantId) {
            filter.must.push({ key: 'tenant_id', match: { value: tenantId } });
        }

        let offset = null;
        do {
            const result = await qdrant.scroll('project_invariants', {
                with_payload: true,
                limit: 50,
                filter,
                ...(offset != null ? { offset } : {}),
            });

            for (const point of result.points) {
                const item = { id: point.id, ...point.payload };
                if (_shouldPromote(item)) {
                    await promoteItem(item, workspacePath);
                }
            }
            offset = result.next_page_offset ?? null;
        } while (offset != null);
    } catch (err) {
        logger.error('Promotion Engine: failed to scroll staging invariants', { error: err.message });
    }
}

/**
 * Return true if this staging item meets the auto-promotion threshold for the
 * current TRUST_MODE.
 *
 * @paramitem
 * @returns
 */
function _shouldPromote(item) {
    const N = item.corroboration_count || 1;
    const c = item.confidence || 0;

    if (config.TRUST_MODE === 'graduated') {
        if (item.type === 'decision'       && N >= 3 && c > 0.85) return true;
        if (item.type === 'det_invariant'  && N >= 2)              return true;
        if (item.type === 'sem_invariant'  && N >= 4 && c > 0.85) return true;
    } else if (config.TRUST_MODE === 'autonomous') {
        if (item.type === 'decision'       && N >= 2 && c > 0.85) return true;
        if (item.type === 'det_invariant'  && N >= 1)              return true;
        if (item.type === 'sem_invariant'  && N >= 2 && c > 0.85) return true;
    }
    return false;
}

module.exports = { evaluateStaging, promoteItem };

export {};
