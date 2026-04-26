/**
 * Multi-tenant Bearer token authentication middleware.
 *
 * Token resolution order:
 *   1. TENANT_TOKENS env var — JSON map of { "<token>": "<tenantId>" }.
 *      Allows per-tenant API keys without a full auth service.
 *   2. KILO_API_TOKEN (legacy single-tenant) — maps to tenantId "default".
 *
 * Security: incoming tokens are SHA-256 hashed before comparison so that the
 * Map lookup never operates on raw secret material.  This prevents a fast-path
 * timing oracle (where Map.get returns early on hash collision buckets) from
 * leaking character-by-character prefix information about stored tokens.
 *
 * On success attaches `req.tenantId` (string) for use by route handlers.
 * Returns 401 if no valid token is found.
 *
 * @module middleware/auth
 */

const { createHash } = require('crypto');
const config = require('../config');
const logger = require('../services/logger');

/**
 * Compute a fixed-length SHA-256 digest of a token string.
 * We compare digests, not raw tokens, so length-variance timing is eliminated.
 */
function hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Build a digest→tenantId lookup map at startup.
 * Parses TENANT_TOKENS (JSON) first; adds the legacy KILO_API_TOKEN last so it
 * cannot override an explicit per-tenant entry that uses the same value.
 *
 * @returns  digest(token) → tenantId
 */
function buildHashedTokenMap(): Map<string, string> {
    const map = new Map<string, string>();

    if (config.TENANT_TOKENS) {
        try {
            const parsed = JSON.parse(config.TENANT_TOKENS);
            for (const [token, tenantId] of Object.entries(parsed)) {
                if (typeof token === 'string' && typeof tenantId === 'string' && token && tenantId) {
                    map.set(hashToken(token), tenantId);
                }
            }
        } catch (e: any) {
            logger.error('TENANT_TOKENS is not valid JSON — ignoring', { error: e.message });
        }
    }

    // Legacy single-token fallback (maps to "default" tenant)
    if (config.KILO_API_TOKEN) {
        const digest = hashToken(config.KILO_API_TOKEN);
        if (!map.has(digest)) {
            map.set(digest, 'default');
        }
    }

    return map;
}

/** Immutable digest map built once at process startup. */
const HASHED_TOKEN_MAP = buildHashedTokenMap();

/**
 * Express middleware that validates the Bearer token and injects
 * `req.tenantId` into the request object.
 *
 * The lookup is timing-safe because we hash the candidate token first.
 * Two candidate tokens that differ in any bit produce completely different
 * SHA-256 digests, so Map.get() never short-circuits on a prefix match
 * against the secret material.
 */
function authMiddleware(req: any, res: any, next: () => void) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn('Auth failed: missing or malformed Authorization header', {
            ip:   req.ip,
            path: req.path,
        });
        return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' });
    }

    const token      = authHeader.slice(7);
    const digest     = hashToken(token);
    const tenantId   = HASHED_TOKEN_MAP.get(digest);

    if (!tenantId) {
        logger.warn('Auth failed: invalid token', { ip: req.ip, path: req.path });
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
    }

    req.tenantId = tenantId;
    next();
}

module.exports = authMiddleware;

export {};
