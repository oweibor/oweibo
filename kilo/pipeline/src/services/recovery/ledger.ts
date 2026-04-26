/**
 * Stage 2: Failure Ledger.
 * Persistent storage of error hashes to track occurrence counts, TTLs, and fix attempts.
 * Implements the 4x wall routing for supervised and graduated trust modes.
 *
 * **Tenant scoping:** ledger entries are stored under
 *   <FAILURE_LEDGER_DIR>/<tenantId>/<hash>.json
 * so that one tenant's repeated failures cannot wall off another tenant's
 * tasks for the same canonical-error hash.  All public functions take a
 * tenantId argument; legacy callers that omit it operate against tenant
 * 'default' (the same name used by the legacy single-token auth path).
 *
 * @module services/recovery/ledger
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../logger');
const queue = require('../queue');
const { safeJoin, sanitizeSegment } = require('../safePath');

const LEDGER_DIR = config.FAILURE_LEDGER_DIR;
const QUARANTINE_BASE = '/var/kilo/quarantine';
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Resolve the per-tenant ledger directory.  Sanitizes the tenantId so a
 * caller-supplied value cannot escape FAILURE_LEDGER_DIR via path traversal.
 */
function tenantLedgerDir(tenantId) {
    const tid = tenantId ? sanitizeSegment(String(tenantId)) : 'default';
    return safeJoin(LEDGER_DIR, tid);
}

/**
 * Resolve the per-tenant + per-hash ledger file path.
 */
function ledgerFilePath(tenantId, hash) {
    const safeHash = sanitizeSegment(String(hash));
    return path.join(tenantLedgerDir(tenantId), `${safeHash}.json`);
}

/**
 * Determine TTL in days based on error category.
 * @paramerrorType
 * @returnsDays until stale
 */
function getTTL(errorType) {
    const type = errorType.toLowerCase();

    // Syntax errors (typos, indentation) stay valid longest
    if (type.includes('syntax') || type.includes('indentation')) return 180;

    // Import and version mismatches
    if (type.includes('import') || type.includes('module') || type.includes('version')) return 30;

    // Stack specific (e.g. Flutter lifecycle, Postgres connection)
    if (type.includes('flutter') || type.includes('postgres') || type.includes('db')) return 60;

    // Default runtime
    return 90;
}

/**
 * Retrieve a ledger entry for a given (tenant, hash).
 * If TTL has expired, sets staleness_flag to true and resets seen_count to 1.
 *
 * @paramhash      - SHA256 canonical hash
 * @parammetadata  - Details to populate on creation (type, key, calling_function)
 * @paramtenantId  - tenant scope for the entry (defaults to 'default')
 * @returnsLedger entry
 */
function getLedgerEntry(hash, metadata, tenantId) {
    const dir = tenantLedgerDir(tenantId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = ledgerFilePath(tenantId, hash);
    const now = new Date().toISOString();

    if (fs.existsSync(filePath)) {
        try {
            const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            const lastSeenStr = entry.last_seen || entry.first_seen || now;
            const msSinceLast = new Date(now).getTime() - new Date(lastSeenStr).getTime();
            const daysSinceLast = msSinceLast / MS_PER_DAY;

            const isStale = daysSinceLast > (entry.ttl_days || getTTL(entry.error_type));

            if (isStale) {
                logger.info('Ledger entry is stale — resetting count', { hash, tenant_id: tenantId });
                entry.staleness_flag = true;
                entry.seen_count = 1;
            } else {
                entry.staleness_flag = false;
                entry.seen_count += 1;
            }

            entry.last_seen = now;
            // Cap fix_attempts to prevent unbounded growth
            if (Array.isArray(entry.fix_attempts) && entry.fix_attempts.length > 50) {
                entry.fix_attempts = entry.fix_attempts.slice(-50);
            }

            return entry;
        } catch (err) {
            logger.error('Failed to parse ledger file (corrupted)', { hash, tenant_id: tenantId, error: err.message });
            // Fall through to recreation
        }
    }

    // Create new
    const ttl = getTTL(metadata.error_type);
    const newEntry = {
        hash,
        tenant_id: tenantId || 'default',
        error_type: metadata.error_type,
        canonical_key: metadata.canonical_key,
        calling_function: metadata.calling_function,
        seen_count: 1,
        first_seen: now,
        last_seen: now,
        dependency_versions: metadata.dependency_versions || null,
        staleness_flag: false,
        ttl_days: ttl,
        fix_attempts: [], // Array of { patch_id, score, applied_at, success }
    };

    return newEntry;
}

/**
 * Write a ledger entry to disk under the tenant-scoped directory.
 * @paramentry     - ledger entry (must include hash)
 * @paramtenantId  - tenant scope
 */
function saveLedgerEntry(entry, tenantId) {
    const filePath = ledgerFilePath(tenantId, entry.hash);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Persist tenant_id alongside the hash so consumers always have it.
    const out = { ...entry, tenant_id: tenantId || entry.tenant_id || 'default' };
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
}

/**
 * Evaluate the 4x Wall (Task 3.3).
 * If seen_count >= 4 and not stale, trigger Trust Mode routing.
 *
 * @paramtaskId
 * @paramentry     - The current ledger entry
 * @paramtenantId  - tenant scope (used to write quarantine file with ownership)
 * @returnsTrue if the pipeline should halt/quarantine, False to continue
 */
function evaluateWall(taskId, entry, tenantId) {
    if (entry.seen_count < 4 || entry.staleness_flag) {
        return false; // Continue down pipeline
    }

    const { TRUST_MODE } = config;
    const reason = `Error hash ${entry.hash} occurred ${entry.seen_count} times.`;

    logger.warn('4x Wall triggered', {
        task_id: taskId, hash: entry.hash, trust_mode: TRUST_MODE, tenant_id: tenantId,
    });

    if (TRUST_MODE === 'supervised') {
        // Block task, requires human intervention via /task/clear
        queue.block(taskId, reason);
        return true; // Halt pipeline
    } else {
        // graduated or autonomous: quarantine the task with tenant ownership
        // recorded in the payload so the /quarantine routes can filter on it.
        const safeHash = sanitizeSegment(String(entry.hash));
        const quarantinePath = path.join(QUARANTINE_BASE, 'tasks', `${safeHash}.json`);

        try {
            fs.mkdirSync(path.dirname(quarantinePath), { recursive: true });
            fs.writeFileSync(quarantinePath, JSON.stringify({
                id: safeHash,
                task_id: taskId,
                tenant_id: tenantId || 'default',
                reason,
                ledger: entry,
                quarantined_at: new Date().toISOString(),
            }, null, 2));
        } catch (err) {
            logger.error('Failed to write to quarantine', { task_id: taskId, error: err.message });
        }

        queue.fail(taskId, reason); // Marks complete (failed) so pipeline continues
        return true; // Halt pipeline for this task
    }
}

/**
 * Reset (delete) a ledger file for a specific (tenant, hash).
 * Allow fresh attempts.
 *
 * @paramhash
 * @paramtenantId
 * @returnstrue if deleted
 */
function resetLedger(hash, tenantId) {
    const filePath = ledgerFilePath(tenantId, hash);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info('Ledger reset', { hash, tenant_id: tenantId });
        return true;
    }
    return false;
}

module.exports = { getLedgerEntry, saveLedgerEntry, evaluateWall, resetLedger, getTTL };

export {};
