/**
 * Scrape API Routes.
 * REST API endpoints for the scraper service.
 * 
 * @module routes/scrape
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const scraperService = require('../services/scraper');
const scraperStorage = require('../services/scraper/storage');

const auth = require('../middleware/auth');
const { scrapeLimiter } = require('../middleware/rateLimiter');
const { sanitizeSegment } = require('../services/safePath');
const { assertSafeTarget } = require('../services/ssrfGuard');
const logger = require('../services/logger');

const router = express.Router();

// Rate limiter for public health endpoint - 100 requests per minute
const healthRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
});

/**
 * POST /scrape/start
 * Start a new scrape job.
 */
router.post('/scrape/start', auth, scrapeLimiter, async (req, res) => {
    try {
        const {
            target_url,
            extraction_type,
            pagination,
            anti_bot,
            output_collection,
            priority,
        } = req.body;

        // Validate required fields
        if (!target_url) {
            return res.status(400).json({
                error: 'target_url is required',
            });
        }

        // SSRF guard — reject non-http(s), userinfo URLs, or hosts that resolve
        // to private/loopback/cloud-metadata IPs.  Defeats DNS-rebinding by
        // resolving once and surfacing the resolved IPs to the caller.
        try {
            await assertSafeTarget(target_url);
        } catch (err) {
            logger.warn('scrape/start rejected unsafe target', {
                tenant_id: (req as any).tenantId,
                target: target_url,
                code: (err as any).code,
                reason: (err as Error).message,
            });
            return res.status((err as any).statusCode || 400).json({
                error: 'Bad Request',
                code: (err as any).code || 'invalid_url',
                message: (err as Error).message,
            });
        }

        const result = await scraperService.startScrape({
            target_url,
            extraction_type,
            pagination,
            anti_bot,
            output_collection,
            priority,
            tenant_id: (req as any).tenantId,
        });

        res.status(201).json(result);
    } catch (error) {
        logger.error('scrape/start failed', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * Validate :jobId route param so it cannot become a path-traversal vector.
 * Scraper jobIds are produced as `scrape-<uuidv4>` — alphanumeric + hyphens,
 * which `sanitizeSegment` already accepts.
 */
function validateJobId(req, res) {
    try {
        return sanitizeSegment(req.params.jobId);
    } catch (err) {
        res.status(400).json({ error: 'Bad Request', message: (err as Error).message });
        return null;
    }
}

/**
 * GET /scrape/status/:jobId
 * Get status of a specific job — tenant-scoped.
 */
router.get('/scrape/status/:jobId', auth, async (req, res) => {
    const jobId = validateJobId(req, res);
    if (!jobId) return;
    const tenantId = (req as any).tenantId;
    try {
        const status = scraperService.getJobStatus(jobId, tenantId);
        if (!status) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.json(status);
    } catch (error) {
        logger.error('scrape/status failed', { jobId, error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /scrape/stop/:jobId
 * Stop a running job — tenant-scoped.
 */
router.post('/scrape/stop/:jobId', auth, async (req, res) => {
    const jobId = validateJobId(req, res);
    if (!jobId) return;
    const tenantId = (req as any).tenantId;
    try {
        const success = scraperService.stopJob(jobId, tenantId);
        if (!success) {
            return res.status(404).json({ error: 'Job not found or not running' });
        }
        res.json({ job_id: jobId, status: 'stopped' });
    } catch (error) {
        logger.error('scrape/stop failed', { jobId, error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /scrape/jobs
 * List the caller's tenant's scrape jobs.
 */
router.get('/scrape/jobs', auth, async (req, res) => {
    try {
        const { status } = req.query;
        const tenantId = (req as any).tenantId;
        const jobs = scraperService.listJobs(status, tenantId);
        res.json({ jobs, count: jobs.length });
    } catch (error) {
        logger.error('scrape/jobs failed', { error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /scrape/results/:jobId
 * Get extracted results for a job — tenant-scoped.
 */
router.get('/scrape/results/:jobId', auth, async (req, res) => {
    const jobId = validateJobId(req, res);
    if (!jobId) return;
    const tenantId = (req as any).tenantId;
    try {
        const job = scraperService.getJobStatus(jobId, tenantId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.json({
            job_id: jobId,
            status: job.status,
            progress: job.progress,
            results: {
                categories_found: job.progress?.categories_found || 0,
                products_extracted: job.progress?.products_extracted || 0,
            },
        });
    } catch (error) {
        logger.error('scrape/results failed', { jobId, error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /scrape/health
 * Health check for scraper service.
 * Note: This endpoint is intentionally public - does not expose sensitive config.
 * Rate limited to prevent abuse.
 */
router.get('/scrape/health', healthRateLimiter, async (req, res) => {
    try {
        // Check Crawl4AI connectivity
        const crawl4aiClient = scraperService.crawl4ai;
        const crawl4aiHealthy = crawl4aiClient ? await crawl4aiClient.healthCheck().catch(() => false) : false;

        // Check storage connectivity
        const storageReady = await scraperService.isStorageReady().catch(() => false);

        const allHealthy = crawl4aiHealthy && storageReady;

        res.json({
            status: allHealthy ? 'healthy' : 'degraded',
            services: {
                crawl4ai: crawl4aiHealthy ? 'up' : 'down',
                storage: storageReady ? 'up' : 'down',
            },
        });
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            error: error.message,
        });
    }
});

/**
 * POST /scrape/search
 * Search scraped content using vector similarity.
 */
router.post('/scrape/search', auth, scrapeLimiter, async (req, res) => {
    try {
        const { query, job_id, limit = 10, min_score = 0.5 } = req.body;

        if (!query) {
            return res.status(400).json({
                error: 'query is required',
            });
        }

        const results = await scraperStorage.search(query, {
            job_id,
            limit,
            minScore: min_score,
        });

        res.json({
            results,
            count: results.length,
        });
    } catch (error) {
        res.status(500).json({
            error: error.message,
        });
    }
});

/**
 * GET /scrape/storage/stats
 * Get storage statistics.
 */
router.get('/scrape/storage/stats', auth, async (req, res) => {
    try {
        const stats = await scraperStorage.getStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({
            error: error.message,
        });
    }
});

/**
 * DELETE /scrape/storage/:jobId
 * Delete all scraped content for a job — tenant-scoped (verifies ownership
 * before issuing the storage delete).
 */
router.delete('/scrape/storage/:jobId', auth, async (req, res) => {
    const jobId = validateJobId(req, res);
    if (!jobId) return;
    const tenantId = (req as any).tenantId;
    try {
        // Ownership check first — refuse the storage delete if the job either
        // doesn't exist or belongs to another tenant.  Returns 404 to avoid
        // enumeration, matching the pattern used elsewhere.
        const owned = scraperService.getJobStatus(jobId, tenantId);
        if (!owned) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const deleted = await scraperStorage.deleteByJob(jobId);
        res.json({ job_id: jobId, deleted });
    } catch (error) {
        logger.error('scrape/storage delete failed', { jobId, error: error.message });
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});


module.exports = router;

export {};
