/**
 * Memory Decay — periodic demotion of stale or unreliable invariants.
 *
 * Runs on DECAY_CRON schedule (default: weekly, Sunday 03:00).
 * Two demotion triggers per invariant:
 *   1. Time-based:    last_used_at older than DECAY_STALE_DAYS (default 90)
 *   2. Quality-based: false_positive_count / total_uses > DECAY_FP_THRESHOLD (default 0.30)
 *
 * On demotion:
 *   - Point is deleted from Qdrant project_invariants
 *   - A new point is upserted into project_invariants with status:'staging',
 *     halved confidence, and demotion metadata so the Promotion Engine can
 *     re-evaluate it on fresh evidence
 *
 * invariants.yaml is never written here. It is a read-only human-inspection
 * artifact generated on demand via `oweibo memory export-invariants`.
 *
 * @module services/promotion/decay
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../logger');
const config = require('../../config');
const qdrant = require('../qdrant');
const embeddings = require('../embeddings');

/**
 * Upsert a demoted invariant back into Qdrant as a staging entry.
 * Uses a new UUID so the Promotion Engine treats it as fresh evidence.
 *
 * @paraminv - Invariant payload from Qdrant (including id)
 * @returns
 */
async function _upsertDemotedToStaging(inv) {
    const demotedId = uuidv4();
    const demotedPayload = {
        ...inv,
        id: demotedId,
        original_id: inv.id,
        confidence: Math.max(0, (inv.confidence || 0.5) * 0.5),
        corroboration_count: 1,
        status: 'staging',
        hit_count: 0,
        false_positive_count: 0,
        demoted_at: new Date().toISOString(),
        demotion_reason: inv._demotion_reason || 'decay',
    };
    delete demotedPayload._demotion_reason;

    // Re-embed so the new staging point is discoverable by semantic search
    const sourceText = demotedPayload.type === 'semantic'
        ? demotedPayload.rule
        : demotedPayload.assertion_template;

    let vector;
    try {
        vector = await embeddings.embed(sourceText || demotedId);
    } catch (embedErr) {
        logger.error('Decay: failed to embed demoted invariant', { id: demotedId, error: embedErr.message });
        throw embedErr;
    }

    await qdrant.upsert('project_invariants', [{ id: demotedId, vector, payload: demotedPayload }]);

    logger.info('Decay: demoted invariant written back to staging (Qdrant)', {
        original_id: inv.id,
        new_staging_id: demotedId,
        reason: demotedPayload.demotion_reason,
    });
}

/**
 * Evaluate and demote stale or low-quality invariants.
 *
 * @param_workspacePath - Retained for backward-compat signature; unused
 * @returns
 */
async function run(_workspacePath) {
    const staleDays   = config.DECAY_STALE_DAYS;
    const fpThreshold = config.DECAY_FP_THRESHOLD;

    logger.info('Memory Decay run started', { staleDays, fpThreshold });

    let evaluated = 0;
    let demoted   = 0;
    let offset    = null;

    // Only scan active invariants — staging entries are awaiting human review
    const activeFilter = {
        must: [{ key: 'status', match: { value: 'active' } }],
    };

    do {
        let result;
        try {
            result = await qdrant.scroll('project_invariants', {
                with_payload: true,
                limit: 50,
                filter: activeFilter,
                ...(offset != null ? { offset } : {}),
            });
        } catch (err) {
            logger.error('Decay: failed to scroll project_invariants', { error: err.message });
            break;
        }

        const { points, next_page_offset } = result;
        offset = next_page_offset ?? null;

        for (const point of points) {
            evaluated++;
            const inv = { id: point.id, ...point.payload };

            const lastUsedAt    = inv.last_used_at ? new Date(inv.last_used_at) : new Date(0);
            const daysSinceUsed = (Date.now() - lastUsedAt.getTime()) / 86_400_000;

            const totalUses = (inv.hit_count || 0) + (inv.false_positive_count || 0);
            const fpRate    = totalUses > 0
                ? (inv.false_positive_count || 0) / totalUses
                : 0;

            const isStale       = daysSinceUsed > staleDays;
            const isUnreliable  = fpRate > fpThreshold && totalUses >= 3;

            if (!isStale && !isUnreliable) continue;

            const reason = isUnreliable
                ? `fp_rate=${fpRate.toFixed(2)} (threshold=${fpThreshold})`
                : `stale=${Math.floor(daysSinceUsed)}d (threshold=${staleDays}d)`;

            logger.warn('Decay: demoting invariant', { id: inv.id, reason });

            inv._demotion_reason = isUnreliable ? 'false_positive_rate' : 'stale';

            // 1. Delete the active point from Qdrant
            try {
                await qdrant.delete('project_invariants', {
                    filter: { must: [{ key: 'id', match: { value: inv.id } }] },
                });
            } catch (err) {
                logger.error('Decay: failed to delete from Qdrant', { id: inv.id, error: err.message });
                continue;
            }

            // 2. Re-insert as a staging entry (halved confidence, new UUID)
            if (config.TRUST_MODE !== 'supervised') {
                try {
                    await _upsertDemotedToStaging(inv);
                } catch (err) {
                    logger.error('Decay: failed to write staging point', { id: inv.id, error: err.message });
                }
            }

            demoted++;
        }
    } while (offset != null);

    logger.info('Memory Decay run complete', { evaluated, demoted });
    return { evaluated, demoted };
}

module.exports = { run };

export {};
