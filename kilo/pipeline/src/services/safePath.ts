/**
 * Filesystem path-safety helper.
 *
 * Prevents directory traversal by resolving the candidate path and asserting
 * that it remains inside the declared root directory.  Drop-in replacement for
 * every `path.join(someRoot, userSuppliedSegment)` call in the pipeline.
 *
 * @module services/safePath
 */

const path = require('path');

/**
 * Join `...segs` onto `root`, resolve the result, then assert it still starts
 * with `root`.  Throws a 400-tagged Error on traversal attempts.
 *
 * @paramroot  - Absolute directory that the result must remain inside
 * @paramsegs  - Path segments to join (may come from user input)
 * @returns     - Resolved absolute path guaranteed to be under root
 */
function safeJoin(root: string, ...segs: string[]): string {
    const normalRoot = path.resolve(root);
    const resolved   = path.resolve(path.join(root, ...segs));

    if (resolved !== normalRoot && !resolved.startsWith(normalRoot + path.sep)) {
        throw Object.assign(
            new Error(`Path traversal rejected: segments [${segs.join(', ')}] escape root '${root}'`),
            { statusCode: 400 }
        );
    }

    return resolved;
}

/**
 * Sanitize a single segment so it can never contain path separators,
 * null bytes, or leading dots (hidden-file trick).
 * Use this for `task_id`, `tenant_id`, or any single-component user value
 * before passing it to `safeJoin`.
 *
 * @paramvalue   - Raw segment from user input
 * @returns       - Sanitized segment, or throws on invalid input
 */
function sanitizeSegment(value: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw Object.assign(
            new Error(`Invalid path segment: must be a non-empty string ≤128 chars`),
            { statusCode: 400 }
        );
    }
    // Allow alphanumeric, hyphen, underscore only (covers UUIDs and slugs)
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
        throw Object.assign(
            new Error(`Invalid path segment: '${value}' contains disallowed characters`),
            { statusCode: 400 }
        );
    }
    return value;
}

module.exports = { safeJoin, sanitizeSegment };

export {};
