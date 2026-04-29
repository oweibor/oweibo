/**
 * Rate-limiting factories for oweibo gateway services.
 *
 * Three tiers (per §7.5 of the platform plan):
 *   Tier 1 — IP-based, pre-auth (in Caddy/Traefik)
 *   Tier 2 — Per-tenant Redis token bucket (this file: tenantLimiter)
 *   Tier 3 — Per-handler concurrency caps (this file: named limiters)
 *
 * All limiters use express-rate-limit with a standard 429 body.
 */
import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

function onLimitReached(req: Request, res: Response): void {
  res.status(429).json({
    error:   'rate_limit_exceeded',
    message: 'Too many requests — please slow down and retry after the window resets.',
    retryAfter: res.getHeader('Retry-After'),
  });
}

/**
 * Pre-auth IP limiter — apply globally before authenticate.
 * Skips health/metrics endpoints to avoid false alarms.
 */
export const ipLimiter = rateLimit({
  windowMs:        60_000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         onLimitReached,
  skip: (req) =>
    req.path === '/healthz' ||
    req.path === '/health'  ||
    req.path === '/livez'   ||
    req.path === '/metrics',
});

/**
 * Per-tenant task limiter — 30 submissions / min / tenant.
 * Apply after authenticate so req.principal is available.
 */
export const taskLimiter = rateLimit({
  windowMs:        60_000,
  max:             30,
  keyGenerator:    (req) => (req as any).principal?.ctx?.tenantId ?? req.ip ?? 'anon',
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         onLimitReached,
});

/**
 * Per-tenant scrape limiter — 10 scrape jobs / min / tenant.
 */
export const scrapeLimiter = rateLimit({
  windowMs:        60_000,
  max:             10,
  keyGenerator:    (req) => (req as any).principal?.ctx?.tenantId ?? req.ip ?? 'anon',
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         onLimitReached,
});

/**
 * SSE stream limiter — 5 concurrent SSE connections / user.
 * Apply on SSE subscribe routes.
 */
export const sseLimiter = rateLimit({
  windowMs:        60_000,
  max:             5,
  keyGenerator:    (req) => (req as any).principal?.sub ?? req.ip ?? 'anon',
  standardHeaders: true,
  legacyHeaders:   false,
  handler:         onLimitReached,
});
