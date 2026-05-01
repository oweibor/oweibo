/**
 * kilo-pipeline — Kilo Code v9 orchestration service.
 *
 * Entry point. Initializes all modules, mounts Express routes,
 * starts the file watcher, and registers graceful shutdown.
 *
 * @module index
 */

const express = require('express');
const config = require('./config');
const logger = require('./services/logger');
const queue = require('./services/queue');
const embeddings = require('./services/embeddings');
const qdrantClient = require('./services/qdrant');
const sandboxClient = require('./services/sandbox');
const watcher = require('./services/watcher');
const memory         = require('./services/memory');
const memoryAdapter  = require('./services/pipelineMemoryAdapter');
const executor = require('./services/executor');
const metrics = require('./services/metrics');

// Phase 3 Recovery Modules
const canonicalize = require('./services/recovery/canonicalize');
const ledger = require('./services/recovery/ledger');
const classifier = require('./services/recovery/classifier');
const searchRouter = require('./services/recovery/searchRouter');
const patchValidator = require('./services/recovery/patchValidator');
const workspaceDiff = require('./services/recovery/workspaceDiff');
const compressor = require('./services/recovery/compressor');
const convergence = require('./services/recovery/convergence');

// Phase 4 Gates & Validation Modules
const staticGates = require('./services/gates/staticGates');
const invariantDet = require('./services/gates/invariantDeterministic');
const invariantSem = require('./services/gates/invariantSemantic');
const adrCheck = require('./services/gates/adrCheck');
const contextCheck = require('./services/gates/contextCheck');
const gateRouting = require('./services/gates/routing');
const snapshot = require('./services/workspace/snapshot');

// Phase 5 Writers & Engine
const writer1 = require('./services/writers/writer1');
const writer2 = require('./services/writers/writer2');
const writer3 = require('./services/writers/writer3');
const writer4 = require('./services/writers/writer4');
const writer5 = require('./services/writers/writer5');
const promotionEngine = require('./services/promotion/engine');

// Self-improvement modules
const cron = require('node-cron');
const memoryDecay = require('./services/promotion/decay');
const idleReflection = require('./services/reflection/idle');
const curriculumDeps = require('./services/curriculum/deps');

// Route handlers
const { safeJoin, sanitizeSegment } = require('./services/safePath');
const taskRoutes = require('./routes/task');
const statusRoutes = require('./routes/status');
const healthRoutes = require('./routes/health');
const stagingRoutes = require('./routes/staging');
const quarantineRoutes = require('./routes/quarantine');
const scrapeRoutes = require('./routes/scrape');

// Shared middleware from @oweibo/api-middleware
const { ipLimiter, requestId, buildLegacyTokenMap, legacyDeprecationHeaders, authenticate } = require('@oweibo/api-middleware');

// Phase 3: NATS + outbox + quota + Redis
const { initNats, drainNats } = require('./services/nats');
const { startOutboxPublisher, stopOutboxPublisher } = require('./services/outboxPublisher');
const { initQuota } = require('./services/quota');

// Build the legacy token map once at startup from TENANT_TOKENS / KILO_API_TOKEN
const legacyTokenMap = buildLegacyTokenMap();

// JWKS config for JWT verification — identity service must be reachable
const jwksCfg = {
  jwksUri:  config.IDENTITY_JWKS_URI || 'http://localhost:3110/.well-known/jwks.json',
  issuer:   config.JWT_ISSUER        || 'https://identity.oweibo.io',
  audience: config.JWT_AUDIENCE      || 'oweibo-api',
};

const app = express();

// --- Middleware ---
app.use(express.json({ limit: '1mb' }));

// Correlation ID + W3C traceparent on every request (before auth so even 401s are correlated)
app.use(requestId);

// Pre-auth IP rate limiter — applied globally before any route processing.
// /health, /metrics, /livez are exempt (see rateLimit.ts skip fn).
app.use(ipLimiter);

// Emit Sunset/Deprecation headers when legacy static tokens are in use
app.use(legacyDeprecationHeaders);

// Request logging — includes request_id and principal sub once auth has run
app.use((req: any, _res: any, next: any) => {
    if (req.path !== '/health' && req.path !== '/healthz') {
        logger.debug('Request', {
            method:     req.method,
            path:       req.path,
            request_id: req.requestId,
            principal:  req.principal?.sub ?? 'unauthenticated',
        });
    }
    next();
});

// --- Routes ---
app.use('/', taskRoutes);
app.use('/', statusRoutes);
app.use('/', healthRoutes);
app.use('/staging', stagingRoutes);
app.use('/quarantine', quarantineRoutes);
app.use('/', scrapeRoutes);

// Liveness endpoint — always 200 if the process is up.
// Distinct from /health (which is the readiness probe — see routes/health.ts).
app.get('/livez', (_req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Prometheus Metrics endpoint — defence-in-depth gating.
// In production /metrics MUST be unreachable from the public ingress
// (network policy / separate listener). The METRICS_TOKEN check is the
// application-layer fallback when network isolation is not present.
app.get('/metrics', async (req, res) => {
    if (config.METRICS_TOKEN) {
        const auth = req.headers.authorization;
        const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (token !== config.METRICS_TOKEN) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    try {
        res.set('Content-Type', metrics.register.contentType);
        // Refresh dynamic metrics before responding
        await metrics.updateQuarantineMetrics();
        // Update scraper vector count if available
        if (metrics.scraperMetrics) {
            try {
                const scraperStorage = require('./services/scraper/storage');
                const stats = await scraperStorage.getStats();
                metrics.scraperMetrics.updateVectorCount(stats.vectorsCount);
            } catch (e) {
                // Scraper not initialized yet
            }
        }
        // Get metrics from both main register and scraper register
        const mainMetrics = await metrics.register.metrics();
        const scraperMetricsOutput = metrics.scraperMetrics
            ? await metrics.scraperMetrics.register.metrics()
            : '';
        // Combine both sets of metrics
        const combined = scraperMetricsOutput
            ? mainMetrics + '\n' + scraperMetricsOutput
            : mainMetrics;
        res.end(combined);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// --- Pipeline execution listener ---
const fs = require('fs');
const path = require('path');

queue.on('task:start', async (task) => {
    const { task_id, tenant_id, instruction, workspace_path } = task;

    // Tier-1 scratchpad — one bucket per (tenant, task). Stages write their
    // outputs here under namespaced keys ('stages.architect', 'stages.orchestrate',
    // 'stages.gates') so any later stage can pull cross-stage state without it
    // being threaded through return values or polluting the queue's task object.
    // Released in finally{} below.
    const wm = memoryAdapter.getWorkingMemory(tenant_id, task_id);

    try {
        // Update task state
        queue.update(task_id, { current_stage: 'memory_retrieval' });
        persistState(task_id);

        // Stage: Memory retrieval (tenant-scoped)
        logger.info('Stage: memory retrieval', { task_id, tenant_id });
        const memoryContext = await memoryAdapter.retrieveMemory(task_id, instruction, tenant_id);
        wm.set('stages.memoryRetrieval', {
            contextLength: memoryContext.length,
            completedAt:   new Date().toISOString(),
        });

        // Stage: Architect
        queue.update(task_id, { current_stage: 'architect' });
        persistState(task_id);

        logger.info('Stage: architect', { task_id });
        const architectResult = await executor.runArchitect(
            task_id,
            instruction,
            memoryContext,
            workspace_path,
            { memoryAdapter, tenantId: tenant_id, workingMemory: wm }
        );

        if (architectResult.exitCode !== 0) {
            queue.update(task_id, { current_stage: 'error_recovery' });
            persistState(task_id);
            queue.fail(task_id, `Architect exited with code ${architectResult.exitCode}`);
            return;
        }

        // Stage: Orchestrate
        queue.update(task_id, { current_stage: 'orchestrate' });
        persistState(task_id);

        logger.info('Stage: orchestrate', { task_id });
        const orchResult = await executor.runOrchestrate(task_id, workspace_path, { memoryAdapter, tenantId: tenant_id, workingMemory: wm });

        // Route based on exit code
        queue.update(task_id, { current_stage: orchResult.route });
        persistState(task_id);

        switch (orchResult.route) {
            case 'gates':
                logger.info('Stage: gates (Phase 4 block)', { task_id });
                try {
                    // changedFiles captured inside runOrchestrate before sandbox cleanup
                    const { changedFiles } = orchResult;

                    // 1. Group K: Static Gates
                    const staticResult = staticGates.evaluateAll('mock_patch', changedFiles, {}, {}, null);
                    if (!staticResult.passed) {
                        queue.update(task_id, { gates_failed: [...(queue.get(task_id).gates_failed || []), 'G1-G7'] });
                        gateRouting.handleT2Failure(task_id, staticResult.violations.join('; '));
                        return;
                    }

                    // 2. Group K: Deterministic Invariants (Gate 8A)
                    const detInvariants = []; // Would load from Qdrant
                    const detResult = await invariantDet.evaluateDeterministic(task_id, 'sandbox_id_stub', detInvariants, changedFiles);
                    if (!detResult.passed) {
                        _writeGateResults(task_id, tenant_id, {
                            passed_invariant_ids: detResult.passedInvariantIds || [],
                            failed_invariant_ids: detResult.failedInvariantIds || [],
                        });
                        queue.update(task_id, { gates_failed: [...(queue.get(task_id).gates_failed || []), 'G8A'] });
                        gateRouting.handleT1Failure(task_id, `Gate 8A: ${detResult.violations[0]}`);
                        return;
                    }

                    // 3. Group L: Semantic Invariants (Gate 8B)
                    const semInvariants = []; // Would load from Qdrant
                    const semResult = await invariantSem.evaluateSemantic(task_id, semInvariants, 'mock_patch_diff');
                    if (!semResult.passed) {
                        _writeGateResults(task_id, tenant_id, {
                            passed_invariant_ids: [
                                ...(detResult.passedInvariantIds || []),
                                ...(semResult.passedInvariantIds || []),
                            ],
                            failed_invariant_ids: semResult.failedInvariantIds || [],
                        });
                        queue.update(task_id, { gates_failed: [...(queue.get(task_id).gates_failed || []), 'G8B'] });
                        // Detailed violations are stage-internal — used only for the immediate
                        // T1 failure handoff. Park them on wm instead of polluting task identity.
                        wm.set('gates.failedDetail', semResult.violations);
                        gateRouting.handleT1Failure(task_id, `Gate 8B: ${semResult.violations[0]}`);
                        return;
                    }

                    // 4. Group L: ADR Check (Gate 9)
                    const adrs = []; // Load promoted from project_decisions
                    const adrResult = await adrCheck.evaluateADRs(task_id, adrs, true, 'mock_patch_diff');
                    if (!adrResult.passed) {
                        queue.update(task_id, { gates_failed: [...(queue.get(task_id).gates_failed || []), 'G9'] });
                        gateRouting.handleT1Failure(task_id, `Gate 9: ${adrResult.violations[0]}`);
                        return;
                    }

                    // 5. Group L: Context Consistency (Gate 10)
                    const ctxMatch = await contextCheck.checkConsistency(task_id, 'Mock Context', 'mock_patch_diff');
                    if (!ctxMatch.passed) {
                        queue.update(task_id, { gates_failed: [...(queue.get(task_id).gates_failed || []), 'G10'] });
                        gateRouting.handleT2Failure(task_id, `Gate 10: ${ctxMatch.breakdown}`);
                        return;
                    }

                    // All Gates Passed!
                    logger.info('Task completely unblocked and finished successfully! (Gate phase cleared)', { task_id });

                    // P-2: reinforce every invariant that fired cleanly this run
                    const allPassedIds = [
                        ...(detResult.passedInvariantIds || []),
                        ...(semResult.passedInvariantIds || []),
                    ];
                    _writeGateResults(task_id, tenant_id, {
                        passed_invariant_ids: allPassedIds,
                        failed_invariant_ids: [],
                    });
                    if (allPassedIds.length > 0) {
                        await Promise.allSettled(
                            allPassedIds.map(id => memoryAdapter.reinforce(id, tenant_id))
                        );
                    }

                    // Tier-1 scratchpad: typed gate summary so writers / promotion
                    // engine / future post-mortem stages can pull it without
                    // re-deriving from the local closure.
                    wm.set('stages.gates', {
                        outcome:             'PASSED',
                        passedInvariantIds:  allPassedIds,
                        adrPassed:           adrResult.passed,
                        contextMatchPassed:  ctxMatch.passed,
                        completedAt:         new Date().toISOString(),
                    });

                    // P-5: write gate-pass stage boundary
                    await memoryAdapter.storeStageOutput({
                        tenantId: tenant_id,
                        taskId:   task_id,
                        stage:    'gates',
                        summary:  `All gates passed — task FULLY_COMPLETED`,
                        detail:   { reinforced: allPassedIds.length },
                    });

                    queue.complete(task_id, { status: 'FULLY_COMPLETED' });

                    // Capture known_good/ snapshot (Task 4.9)
                    await snapshot.captureSnapshot(task_id, workspace_path);

                    // --- Phase 5: Writers & Promotion (Stage 9) ---
                    const taskObj = queue.get(task_id) || { id: task_id, instruction: 'Unknown', strategy_index: 0 };

                    // W3, W4, W5 (Non-LLM / Context Writers)
                    await writer3.writeReasoning(taskObj, 'FULLY_COMPLETED');
                    await writer4.writeSummary(taskObj, { files_modified: Object.keys(changedFiles || {}) });
                    await writer5.writeContext(workspace_path, `Task ${task_id} completed successfully modifying ${Object.keys(changedFiles || {}).length} files.`, task_id);

                    // W1 & W2 (LLM Extractors)
                    await writer1.extractADR(task_id, workspace_path, 'mock_patch_diff');
                    await writer2.extractInvariants(task_id, workspace_path, 'mock_patch_diff');

                    // Evaluate Staging / Auto-Promote (Task 5.6)
                    await promotionEngine.evaluateStaging(workspace_path, tenant_id);

                    // Stage 9 Ledger Entry (Task 5.10)
                    const s9Entry = {
                        error_hash: 'none',
                        task_id,
                        outcome: 'FULLY_COMPLETED',
                        dependency_versions: {},
                        ttl_days: 180,
                        staleness_flag: false,
                        gate_8a_result: { passed: detResult.passed, violations: detResult.violations || [] },
                        gate_8b_result: { passed: semResult.passed, violations: semResult.violations || [] },
                        deterministic_violations: detResult.violations || [],
                        semantic_violations: semResult.violations || [],
                        gate_severity_results: { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true, G7: true, G8A: detResult.passed, G8B: semResult.passed, G9: adrResult.passed, G10: ctxMatch.passed },
                        written_at: new Date().toISOString()
                    };
                    const fsS9 = require('fs');
                    fsS9.mkdirSync('/var/kilo/failure_ledger', { recursive: true });
                    fsS9.writeFileSync(`/var/kilo/failure_ledger/stage9_${task_id}.json`, JSON.stringify(s9Entry, null, 2));

                } catch (gateErr) {
                    logger.error('Gate evaluation pipeline crashed', { task_id, error: gateErr.message });
                    queue.fail(task_id, 'Gate execution failed: ' + gateErr.message);
                }
                break;

            case 'error_recovery':
                logger.info('Stage: error_recovery', { task_id });
                try {
                    // Extract error context from orchestrator output.
                    // The executor redirects stderr→stdout via 2>&1, so stderr is usually empty.
                    // Fall back to stdout (stripping the injected EXIT_CODE marker) when stderr is absent.
                    const errText = orchResult.stderr.trim() || orchResult.stdout.replace(/EXIT_CODE:\d+\s*$/m, '').trim();
                    const errObj = { type: 'RuntimeError', message: errText.substring(0, 200), stack: errText };

                    // Accumulate error history for idle reflection (convergence.js reads this on quarantine)
                    const currentErrors = queue.get(task_id).error_history || [];
                    queue.update(task_id, {
                        error_history: [...currentErrors, {
                            stage: 'error_recovery',
                            strategy_index: queue.get(task_id).strategy_index || 0,
                            error: errObj.message,
                            timestamp: new Date().toISOString(),
                        }]
                    });

                    // Stage 1: Canonicalize
                    const canonicalError = canonicalize.canonicalize(errObj);
                    logger.debug('Error canonicalized', { hash: canonicalError.hash });

                    // Stage 2: Ledger & 4x Wall — tenant-scoped so one tenant's
                    // failures cannot wall off another tenant's tasks.
                    const ledgerEntry = ledger.getLedgerEntry(canonicalError.hash, canonicalError, tenant_id);
                    ledger.saveLedgerEntry(ledgerEntry, tenant_id);

                    if (ledger.evaluateWall(task_id, ledgerEntry, tenant_id)) {
                        // Task blocked or quarantined
                        return;
                    }

                    // Stage 3: Classify & Route
                    const errorClass = classifier.classify(canonicalError);
                    if (errorClass === 'COMPLEX') {
                        const searchResult = await searchRouter.routeSearch(canonicalError);
                        logger.debug('Search strategy selected', { strategy: searchResult.strategy });
                    }

                    // For now, we update task state to indicate we are looping back or waiting
                    // A real implementation would loop back to orchestrator or architect here
                    queue.fail(task_id, `Error recovery pipeline initiated for ${canonicalError.hash}`);
                } catch (recErr) {
                    logger.error('Error in recovery pipeline', { error: recErr.message });
                    queue.fail(task_id, 'Recovery pipeline crashed');
                }
                break;

            case 'convergence': {
                logger.info('Stage: convergence', { task_id });
                // Stage 7: Convergence check
                const taskRef = queue.get(task_id);
                const strategyIndex = taskRef.strategy_index || 0;

                const ladderResult = convergence.checkConvergence(task_id, strategyIndex);

                if (ladderResult.halted) {
                    return; // Task blocked or quarantined
                }

                // Advance ladder
                queue.update(task_id, { strategy_index: ladderResult.nextIndex });
                persistState(task_id);

                logger.info('Ladder advanced, pipeline continuing', { next_strategy: ladderResult.action });
                queue.fail(task_id, `Convergence continuing with strategy ${ladderResult.action}`);
                break;
            }

            default:
                queue.fail(task_id, `Unknown route: ${orchResult.route}`);
        }
    } catch (err) {
        logger.error('Pipeline execution error', { task_id, error: err.message });
        queue.fail(task_id, err);
    } finally {
        // Release the per-task WorkingMemory bucket regardless of success or
        // failure. Without this, every completed task leaks its tier-1
        // scratchpad for the lifetime of the process.
        try {
            memoryAdapter.releaseWorkingMemory(tenant_id, task_id);
        } catch (releaseErr) {
            logger.warn('WorkingMemory release failed (non-fatal)', {
                task_id, error: releaseErr.message,
            });
        }
    }
});

/**
 * Write gate evaluation results (passed/failed invariant IDs) to the checkpoint
 * so the staging approve route can penalise false positives on human override.
 * Path: CHECKPOINT_DIR/<tenantId>/<taskId>/gate_results.json
 *
 * @paramtaskId
 * @paramtenantId
 * @paramresults
 */
function _writeGateResults(taskId, tenantId, results) {
    try {
        const dir = safeJoin(
            config.CHECKPOINT_DIR,
            sanitizeSegment(tenantId || 'default'),
            sanitizeSegment(taskId)
        );
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'gate_results.json'),
            JSON.stringify({ task_id: taskId, ...results, written_at: new Date().toISOString() }, null, 2)
        );
    } catch (err) {
        logger.error('Failed to persist gate results', { task_id: taskId, error: err.message });
    }
}

/**
 * Persist task state to tenant-scoped checkpoint dir.
 * Path: CHECKPOINT_DIR/<tenantId>/<taskId>/state.json
 * @paramtaskId
 */
function persistState(taskId) {
    const task = queue.get(taskId);
    if (!task) return;
    const tenantId  = task.tenant_id || 'default';
    const stateDir  = safeJoin(
        config.CHECKPOINT_DIR,
        sanitizeSegment(tenantId),
        sanitizeSegment(taskId)
    );
    const statePath = path.join(stateDir, 'state.json');
    try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(task, null, 2));
    } catch (err) {
        logger.error('Failed to persist state', {
            task_id:   taskId,
            tenant_id: tenantId,
            error:     err.message,
        });
    }
}

// --- Startup ---
async function main() {
    logger.info('kilo-pipeline starting', {
        version: '0.1.0',
        trust_mode: config.TRUST_MODE,
        port: config.PORT,
    });

    // Initialize Phase 3 services (NATS, Redis quota)
    try {
        const Redis = require('ioredis');
        const redis = new Redis(config.REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
        redis.on('error', (err) => logger.warn('[redis] connection error', { error: err.message }));
        await redis.connect().catch(() => logger.warn('[redis] connect failed — quota service degraded'));
        initQuota(redis);

        await initNats().catch(err => logger.warn('[nats] connect failed — event bus degraded', { error: err.message }));
        startOutboxPublisher();
    } catch (err) {
        logger.warn('Phase 3 service init failed — continuing in degraded mode', { error: err.message });
    }

    // Initialize services
    try {
        logger.info('Initializing Qdrant client...');
        qdrantClient.initialize();

        logger.info('Initializing Docker sandbox client...');
        sandboxClient.initialize();

        logger.info('Initializing MiniLM embedding model...');
        await embeddings.initialize();
        logger.info('Embedding model ready');
    } catch (err) {
        logger.error('Service initialization failed', { error: err.message });
        logger.warn('Pipeline starting in degraded mode — some features may not work');
    }

    // Start file watcher
    try {
        watcher.start();
    } catch (err) {
        logger.error('File watcher failed to start', { error: err.message });
    }

    // --- Self-improvement cron jobs ---

    // Memory Decay: weekly demotion of stale / high-false-positive invariants
    cron.schedule(config.DECAY_CRON, async () => {
        logger.info('Memory Decay cron triggered');
        try {
            await memoryDecay.run(config.KILO_PROJECT_DIR);
        } catch (err) {
            logger.error('Memory Decay cron failed', { error: err.message });
        }
    });
    logger.info('Memory Decay cron registered', { schedule: config.DECAY_CRON });

    // Idle Reflection: hourly quarantine analysis when queue is empty
    cron.schedule(config.IDLE_REFLECTION_CRON, async () => {
        logger.debug('Idle Reflection cron triggered');
        try {
            await idleReflection.runIfIdle(config.KILO_PROJECT_DIR, queue);
        } catch (err) {
            logger.error('Idle Reflection cron failed', { error: err.message });
        }
    });
    logger.info('Idle Reflection cron registered', { schedule: config.IDLE_REFLECTION_CRON });

    // Curriculum Learning: weekly dependency changelog scraping
    cron.schedule(config.CURRICULUM_CRON, async () => {
        logger.info('Curriculum Learning cron triggered');
        try {
            await curriculumDeps.run();
        } catch (err) {
            logger.error('Curriculum Learning cron failed', { error: err.message });
        }
    });
    logger.info('Curriculum Learning cron registered', { schedule: config.CURRICULUM_CRON });

    // Start HTTP server
    const server = app.listen(config.PORT, () => {
        logger.info(`kilo-pipeline listening on :${config.PORT}`, {
            health: `http://localhost:${config.PORT}/health`,
        });
    });

    // --- Graceful shutdown ---
    const shutdown = async (signal) => {
        logger.info(`${signal} received — shutting down gracefully`);

        stopOutboxPublisher();
        await drainNats().catch(() => {});
        watcher.stop();

        server.close(() => {
            logger.info('HTTP server closed');
            process.exit(0);
        });

        // Force kill after 10s
        setTimeout(() => {
            logger.error('Graceful shutdown timed out — forcing exit');
            process.exit(1);
        }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
    logger.error('Fatal startup error', { error: err.message });
    process.exit(1);
});

export {};
