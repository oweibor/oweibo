/**
 * Express rate-limiter factories.
 *
 * Two tiers:
 *   1. ipLimiter  — applied before auth, keys by IP.  Prevents unauthenticated
 *                   enumeration and brute-force on the auth middleware itself.
 *   2. tenantLimiter — applied after auth, keys by tenant ID.  Provides fair
 *                      per-tenant quotas and prevents a single tenant from
 *                      exhausting queue capacity.
 *
 * express-rate-limit is already a declared dependency (package.json).
 *
 * @module middleware/rateLimiter
 */

const rateLimit = require('express-rate-limit');
const logger    = require('../services/logger');

/** Standard 429 response body shared by both limiters. */
function limitReached(req: any, res: any) {
    logger.warn('Rate limit reached', {
        ip:        req.ip,
        tenant_id: req.tenantId || 'unauthenticated',
        path:      req.path,
    });
    res.status(429).json({
        error:   'Too Many Requests',
        message: 'Rate limit exceeded — please slow down and retry after the window resets.',
    });
}

/**
 * Pre-auth limiter: 60 requests per minute per IP across all routes.
 * Protects the auth middleware from brute-force enumeration.
 */
const ipLimiter = rateLimit({
    windowMs:        60_000,
    max:             60,
    standardHeaders: true,
    legacyHeaders:   false,
    handler:         limitReached,
    skip:            (req: any) => req.path === '/health' || req.path === '/metrics' || req.path === '/livez',
});

/**
 * Post-auth limiter for the /task endpoint: 30 task submissions per minute
 * per tenant.  Exceeding this returns 429 before the task reaches the queue.
 */
const taskLimiter = rateLimit({
    windowMs:        60_000,
    max:             30,
    keyGenerator:    (req: any) => req.tenantId || req.ip,
    standardHeaders: true,
    legacyHeaders:   false,
    handler:         limitReached,
});

/**
 * Post-auth limiter for the /scrape endpoint: 10 scrape jobs per minute per
 * tenant.  Crawl4AI requests are heavier than task submissions.
 */
const scrapeLimiter = rateLimit({
    windowMs:        60_000,
    max:             10,
    keyGenerator:    (req: any) => req.tenantId || req.ip,
    standardHeaders: true,
    legacyHeaders:   false,
    handler:         limitReached,
});

module.exports = { ipLimiter, taskLimiter, scrapeLimiter };

export {};
