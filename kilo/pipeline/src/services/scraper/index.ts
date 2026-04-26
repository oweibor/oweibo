/**
 * Scraper Service - LangGraph + Crawl4AI Integration.
 * 
 * This module provides the orchestration layer for web scraping operations.
 * It integrates:
 * - LangGraph: For state machine orchestration (pagination, retries)
 * - Crawl4AI: For actual page fetching and extraction
 * 
 * @module services/scraper
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const Crawl4AIClient = require('./crawl4ai/client');
const config = require('../config');
const scraperConfig = require('./config');
const scraperStorage = require('./storage');
const scraperMetrics = require('./metrics');
const { LangGraphRunner, FileCheckpointStore } = require('./langgraph');
const logger = require('../logger');

// Anti-detection managers (lazy loaded to avoid initialization issues)
let fingerprintManager = null;
let ipv6Manager = null;
let hybridNetworkManager = null;
let wifiRotationManager = null;
let ultimateFallback = null;

/**
 * Lazy-load anti-detection managers.
 * @private
 */
function _getAntiDetectionManagers() {
    if (!fingerprintManager) {
        try {
            fingerprintManager = require('./fingerprintManager');
        } catch (e) {
            logger.debug('FingerprintManager not available');
        }
    }
    if (!ipv6Manager) {
        try {
            const ipv6Module = require('./ipv6Manager');
            ipv6Manager = ipv6Module.getInstance ? ipv6Module.getInstance() : ipv6Module;
        } catch (e) {
            logger.debug('IPv6Manager not available');
        }
    }
    if (!hybridNetworkManager) {
        try {
            const hybridModule = require('./hybridNetworkManager');
            hybridNetworkManager = hybridModule.getInstance ? hybridModule.getInstance() : hybridModule;
        } catch (e) {
            logger.debug('HybridNetworkManager not available');
        }
    }
    if (!wifiRotationManager) {
        try {
            const wifiModule = require('./wifiRotationManager');
            wifiRotationManager = wifiModule.getInstance ? wifiModule.getInstance() : wifiModule;
        } catch (e) {
            logger.debug('WiFiRotationManager not available');
        }
    }
    if (!ultimateFallback) {
        try {
            const fallbackModule = require('./ultimateFallback');
            ultimateFallback = fallbackModule.getInstance ? fallbackModule.getInstance() : fallbackModule;
        } catch (e) {
            logger.debug('UltimateFallback not available');
        }
    }

    return {
        fingerprintManager,
        ipv6Manager,
        hybridNetworkManager,
        wifiRotationManager,
        ultimateFallback,
    };
}

/**
 * Scrape job states
 */
const JOB_STATES = {
    PENDING: 'pending',
    RUNNING: 'running',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
};

/**
 * Scraper Service class.
 * Manages scrape jobs and orchestrates LangGraph state machines.
 */
class ScraperService extends EventEmitter {
    [key: string]: any;


    constructor() {
        super();
        this.crawl4ai = new Crawl4AIClient();
        this.jobs = new Map();
        this.profile = scraperConfig.getScrapeProfile();
        this.jobRetentionMs = 24 * 60 * 60 * 1000; // Keep jobs for 24 hours

        // Initialize checkpoint store - use main config which has correct CHECKPOINT_DIR
        const checkpointBasePath = config.CHECKPOINT_DIR
            || process.env.CHECKPOINT_DIR
            || '/var/kilo/checkpoints';

        this.checkpointStore = new FileCheckpointStore({
            basePath: checkpointBasePath,
        });

        // Initialize storage (Qdrant collection)
        this._initializeStorage().catch(err => {
            logger.warn('Scraper storage initialization deferred', { error: err.message });
        });

        // Start periodic cleanup of old jobs
        this._startJobCleanup();

        logger.info('Scraper service initialized', {
            profile: config.HARDWARE_PROFILE || 'unknown',
            maxConcurrent: this.profile.max_concurrent,
        });

        // Initialize anti-detection managers
        const managers = _getAntiDetectionManagers();
        logger.debug('Anti-detection managers loaded', {
            fingerprint: !!managers.fingerprintManager,
            ipv6: !!managers.ipv6Manager,
            hybrid: !!managers.hybridNetworkManager,
            wifi: !!managers.wifiRotationManager,
            fallback: !!managers.ultimateFallback,
        });
    }

    /**
     * Get status of all anti-detection managers.
     * @returnsStatus of all managers
     */
    async getAntiDetectionStatus() {
        const managers = _getAntiDetectionManagers();

        const status = {
            fingerprint: null,
            ipv6: null,
            hybrid: null,
            wifi: null,
            fallback: null,
        };

        if (managers.fingerprintManager) {
            status.fingerprint = { enabled: true };
        }

        if (managers.ipv6Manager) {
            try {
                await managers.ipv6Manager.checkStatus();
                status.ipv6 = managers.ipv6Manager.status;
            } catch (error) {
                logger.debug('Failed to get IPv6 status', { error: error.message });
            }
        }

        if (managers.hybridNetworkManager) {
            try {
                await managers.hybridNetworkManager.checkStatus();
                status.hybrid = managers.hybridNetworkManager.status;
            } catch (error) {
                logger.debug('Failed to get hybrid network status', { error: error.message });
            }
        }

        if (managers.wifiRotationManager) {
            try {
                status.wifi = managers.wifiRotationManager.getStatus();
            } catch (error) {
                logger.debug('Failed to get WiFi rotation status', { error: error.message });
            }
        }

        if (managers.ultimateFallback) {
            try {
                status.fallback = managers.ultimateFallback.getStatus();
            } catch (error) {
                logger.debug('Failed to get fallback status', { error: error.message });
            }
        }

        return status;
    }

    /**
     * Periodically clean up old completed jobs to prevent memory leak.
     * @private
     */
    _startJobCleanup() {
        setInterval(() => {
            const now = Date.now();
            let cleaned = 0;

            for (const [jobId, job] of this.jobs.entries()) {
                const jobEndTime = job.completed_at || job.stopped_at;
                if (jobEndTime) {
                    const age = now - new Date(jobEndTime).getTime();
                    if (age > this.jobRetentionMs) {
                        this.jobs.delete(jobId);
                        cleaned++;
                    }
                }
            }

            if (cleaned > 0) {
                logger.debug('Cleaned up old scrape jobs', { count: cleaned });
            }
        }, 60 * 60 * 1000); // Run every hour
    }

    /**
     * Initialize storage - ensure Qdrant collection exists.
     * @private
     */
    async _initializeStorage() {
        try {
            await scraperStorage.initialize();
            logger.info('Scraper storage initialized');
        } catch (error) {
            logger.warn('Scraper storage initialization failed', { error: error.message });
        }
    }

    /**
     * Check if storage is ready for operations.
     * @returnsStorage ready status
     */
    async isStorageReady() {
        try {
            await scraperStorage.getStats();
            return true;
        } catch (error) {
            logger.warn('Storage health check failed', { error: error.message });
            return false;
        }
    }

    /**
     * Start a new scrape job.
     *
     * **tenant_id is required** — every job is owned by exactly one tenant,
     * and every read/list/stop/delete operation enforces that ownership.  The
     * route layer derives tenant_id from the authenticated JWT/api key; never
     * from the request body.
     *
     * @paramoptions - Scrape options (must include tenant_id)
     * @returnsJob info
     */
    async startScrape(options) {
        const {
            target_url,
            extraction_type = 'product',
            pagination = { enabled: true, max_pages: 100 },
            anti_bot = scraperConfig.antiBot.mode,
            output_collection = scraperConfig.qdrant.collectionName,
            priority = 'normal',
            tenant_id,
        } = options;

        if (!tenant_id || typeof tenant_id !== 'string') {
            const err: any = new Error('tenant_id is required to start a scrape job');
            err.statusCode = 400;
            throw err;
        }

        const job_id = `scrape-${uuidv4()}`;

        const job: any = {
            job_id,
            tenant_id,
            status: JOB_STATES.RUNNING,
            target_url,
            extraction_type,
            pagination,
            anti_bot,
            output_collection,
            priority,
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            progress: {
                pages_crawled: 0,
                products_extracted: 0,
                categories_found: 0,
                failed_pages: 0,
            },
            current_url: target_url,
            visited_urls: [],
            failed_urls: [],
            consecutive_failures: 0,
        };

        this.jobs.set(job_id, job);

        // Record metrics
        scraperMetrics.recordJobStarted();

        logger.info('Scrape job started', { job_id, target_url });

        // Emit event for downstream subscribers
        this.emit('job:started', job);

        // Start the scraping process in background
        this._runScrapeJob(job).catch(err => {
            logger.error('Scrape job failed', { job_id, error: err.message });
            job.status = JOB_STATES.FAILED;
            job.error = err.message;
            this.emit('job:failed', job);
        });

        return {
            job_id,
            status: job.status,
            started_at: job.started_at,
            target_url,
        };
    }

    /**
     * Get job status — tenant-scoped.
     *
     * Returns null if no such job, or if it belongs to a different tenant.
     * Both cases produce the same result so callers can return 404 without
     * leaking the existence of cross-tenant jobs.
     *
     * @paramjobId    - Job ID
     * @paramtenantId - caller's tenant id (required)
     * @returnsJob status or null
     */
    getJobStatus(jobId, tenantId) {
        const job = this.jobs.get(jobId);
        if (!job) return null;
        if (!tenantId || job.tenant_id !== tenantId) return null;

        return {
            job_id: job.job_id,
            status: job.status,
            progress: job.progress,
            current_url: job.current_url,
            started_at: job.started_at,
            completed_at: job.completed_at,
            error: job.error,
        };
    }

    /**
     * List all jobs for the caller's tenant.
     *
     * @paramstatus    - Optional status filter
     * @paramtenantId  - caller's tenant id (required)
     * @returnsList of jobs owned by the tenant
     */
    listJobs(status = null, tenantId = null) {
        if (!tenantId) return [];
        const jobs = Array.from(this.jobs.values()).filter((j: any) => j.tenant_id === tenantId);
        if (status) {
            return jobs.filter((j: any) => j.status === status);
        }
        return jobs;
    }

    /**
     * Stop a running job — tenant-scoped.
     *
     * Returns false if the job does not exist OR belongs to another tenant
     * OR is not currently running.
     *
     * @paramjobId    - Job ID
     * @paramtenantId - caller's tenant id (required)
     * @returnsSuccess
     */
    stopJob(jobId, tenantId) {
        const job = this.jobs.get(jobId);
        if (!job) return false;
        if (!tenantId || job.tenant_id !== tenantId) return false;
        if (job.status !== JOB_STATES.RUNNING) return false;

        job.status = JOB_STATES.CANCELLED;
        job.stopped_at = new Date().toISOString();

        logger.info('Scrape job stopped', { jobId, tenant_id: tenantId });
        this.emit('job:stopped', job);

        return true;
    }

    /**
     * Internal: Run the scrape job using LangGraph-style state machine.
     * @paramjob - Job object
     * @private
     */
    async _runScrapeJob(job) {
        // Create LangGraph runner
        const runner = new LangGraphRunner({
            crawl4ai: this.crawl4ai,
            checkpointStore: this.checkpointStore,
            onProgress: (progress) => {
                // Update job progress
                job.progress = {
                    pages_crawled: progress.pages_crawled,
                    products_extracted: progress.products_extracted,
                    categories_found: progress.categories_found,
                    failed_pages: progress.failed_pages,
                };
                job.current_url = progress.current_url;
                this.emit('job:progress', this.getJobStatus(job.job_id, job.tenant_id));
            },
            onComplete: (finalState) => {
                job.status = JOB_STATES.COMPLETED;
                job.completed_at = new Date().toISOString();
                job.progress = {
                    pages_crawled: finalState.visited_urls.length,
                    products_extracted: finalState.products.length,
                    categories_found: finalState.categories.length,
                    failed_pages: finalState.total_failures,
                    final: true,
                };

                // Record metrics
                scraperMetrics.recordJobCompleted('completed');
                scraperMetrics.recordPagesCrawled(finalState.visited_urls.length, 'success');
                scraperMetrics.recordItemsExtracted('product', finalState.products.length);
                scraperMetrics.recordItemsExtracted('category', finalState.categories.length);

                logger.info('Scrape job completed via LangGraph', {
                    job_id: job.job_id,
                    pages: finalState.visited_urls.length,
                    products: finalState.products.length,
                });
                this.emit('job:completed', job);
            },
            onError: (error) => {
                job.status = JOB_STATES.FAILED;
                job.error = error.message;

                // Record metrics
                scraperMetrics.recordJobCompleted('failed');

                logger.error('Scrape job failed via LangGraph', {
                    job_id: job.job_id,
                    error: error.message,
                });
                this.emit('job:failed', job);
            },
        });

        try {
            // Run the LangGraph
            await runner.run({
                job_id: job.job_id,
                target_url: job.target_url,
                extraction_type: job.extraction_type,
                max_pages: job.pagination?.max_pages || 100,
                anti_bot: job.anti_bot,
            });
        } catch (error) {
            job.status = JOB_STATES.FAILED;
            job.error = error.message;
            this.emit('job:failed', job);
            throw error;
        }
    }

    /**
     * Process a crawled page.
     * @paramstate - Current state
     * @paramresult - Crawl result
     * @paramjob - Job object
     * @private
     */
    async _processPage(state, result, job) {
        if (job.extraction_type === 'category') {
            // Extract category links
            const categoryLinks = this._extractLinks(result.links, ['category', 'department', 'section']);
            state.categories.push(...categoryLinks);
        } else if (job.extraction_type === 'product') {
            // Extract product links
            const productLinks = this._extractLinks(result.links, ['product', 'item', 'pdp']);
            state.products.push(...productLinks);
        } else if (job.extraction_type === 'multi') {
            // Extract both categories and products
            const categoryLinks = this._extractLinks(result.links, ['category', 'department', 'section']);
            const productLinks = this._extractLinks(result.links, ['product', 'item', 'pdp']);

            state.categories.push(...categoryLinks);
            state.products.push(...productLinks);
        }
    }

    /**
     * Check if there's a next page.
     * @paramstate - Current state
     * @paramresult - Crawl result
     * @returnsHas next page
     * @private
     */
    async _checkPagination(state, result) {
        // Check for common pagination patterns in links
        const nextPagePatterns = ['next', 'page', 'p=', 'page='];

        for (const link of result.links || []) {
            const href = link.href?.toLowerCase() || '';
            const text = link.text?.toLowerCase() || '';

            for (const pattern of nextPagePatterns) {
                if (href.includes(pattern) || text.includes(pattern)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Extract next page URL from links.
     * @paramlinks - Array of links
     * @returnsNext page URL
     * @private
     */
    _extractNextPageUrl(links) {
        const nextPagePatterns = ['next', 'page', 'p=', 'page='];

        for (const link of links || []) {
            const href = link.href?.toLowerCase() || '';
            const text = link.text?.toLowerCase() || '';

            for (const pattern of nextPagePatterns) {
                if (href.includes(pattern) || text.includes(pattern)) {
                    return link.href;
                }
            }
        }

        return null;
    }

    /**
     * Extract links matching patterns.
     * @paramlinks - Array of links
     * @parampatterns - Patterns to match
     * @returnsFiltered links
     * @private
     */
    _extractLinks(links, patterns) {
        return (links || []).filter(link => {
            const href = link.href?.toLowerCase() || '';
            const text = link.text?.toLowerCase() || '';

            return patterns.some(pattern =>
                href.includes(pattern) || text.includes(pattern)
            );
        });
    }

    /**
     * Sleep for specified milliseconds.
     * @paramms - Milliseconds
     * @private
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export singleton instance
const scraperService = new ScraperService();

module.exports = scraperService;
module.exports.JOB_STATES = JOB_STATES;
module.exports.ScraperService = ScraperService;
// Bind method to service instance for cleaner export
module.exports.getAntiDetectionStatus = scraperService.getAntiDetectionStatus.bind(scraperService);

export {};
