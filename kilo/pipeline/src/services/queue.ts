/**
 * Hardware-aware parallel task queue with per-tenant concurrency isolation.
 *
 * Global concurrency is bounded by config.MAX_CONCURRENCY (hardware-aware).
 * Per-tenant concurrency is additionally bounded by config.TENANT_MAX_CONCURRENCY
 * so a single tenant cannot starve others.
 *
 * @module services/queue
 */

const { EventEmitter } = require('events');
const logger  = require('./logger');
const metrics = require('./metrics');
const config  = require('../config');
const { writeOutboxEvent } = require('./outboxPublisher');

class TaskQueue extends EventEmitter {
    [key: string]: any;


    /**
     * @parammaxConcurrency       - Global max parallel tasks
     * @paramtenantMaxConcurrency - Per-tenant max parallel tasks
     */
    constructor(maxConcurrency = 1, tenantMaxConcurrency = 2) {
        super();

        /** @type*/
        this._maxConcurrency = maxConcurrency;

        /** @typePer-tenant hard cap */
        this._tenantMaxConcurrency = tenantMaxConcurrency;

        /** @typeAll tasks by ID (any state) */
        this._tasks = new Map();

        /** @typeOrdered queue of task IDs waiting to run */
        this._pending = [];

        /** @typeCurrently executing tasks (taskId → task) */
        this._running = new Map();

        /** @typeRunning count per tenantId */
        this._tenantRunning = new Map();

        logger.info('TaskQueue initialized', {
            maxConcurrency: this._maxConcurrency,
            tenantMaxConcurrency: this._tenantMaxConcurrency,
        });
    }

    // -------------------------------------------------------------------------
    // Public read accessors
    // -------------------------------------------------------------------------

    get concurrency() {
        return { current: this._running.size, max: this._maxConcurrency };
    }

    get canAcceptMore() {
        return this._running.size < this._maxConcurrency;
    }

    get size() { return this._pending.length; }

    get runningCount() { return this._running.size; }

    /** First running task ID (backward compat — prefer runningCount). */
    get currentTaskId() {
        return this._running.keys().next().value || null;
    }

    /**
     * Number of running tasks for a given tenant.
     * @paramtenantId
     * @returns
     */
    tenantRunningCount(tenantId) {
        return this._tenantRunning.get(tenantId) || 0;
    }

    // -------------------------------------------------------------------------
    // Core queue operations
    // -------------------------------------------------------------------------

    /**
     * Enqueue a new task.  Rejects duplicates with 409.
     *
     * @paramtask - Must include task_id, tenant_id, workspace_path, instruction
     * @returns
     */
    enqueue(task) {
        const { task_id, tenant_id } = task;

        if (!tenant_id) {
            const err = new Error('tenant_id is required');
            (err as any).statusCode = 400;
            throw err;
        }

        if (this._tasks.has(task_id)) {
            const err = new Error(`Task ${task_id} already exists`);
            (err as any).statusCode = 409;
            throw err;
        }

        const now = new Date().toISOString();
        const entry = {
            ...task,
            status:        'queued',
            current_stage: null,
            started_at:    null,
            updated_at:    now,
            created_at:    now,
            result:        null,
        };

        this._tasks.set(task_id, entry);
        this._pending.push(task_id);

        logger.info('Task enqueued', {
            task_id,
            tenant_id,
            queue_size: this._pending.length,
            running:    this._running.size,
            max:        this._maxConcurrency,
        });

        writeOutboxEvent(`tasks.${tenant_id}.submit`, { type: 'task-queued', taskId: task_id, tenantId: tenant_id });

        this._processNext();

        return { task_id, status: 'queued' };
    }

    get(taskId) {
        return this._tasks.get(taskId) || null;
    }

    getAll() {
        return Array.from(this._tasks.values());
    }

    getActive() {
        return Array.from(this._running.values());
    }

    getPending() {
        return this._pending.map((id) => this._tasks.get(id)).filter(Boolean);
    }

    /**
     * Get all tasks for a specific tenant.
     * @paramtenantId
     * @returns
     */
    getByTenant(tenantId) {
        return Array.from(this._tasks.values()).filter((t: any) => t.tenant_id === tenantId);
    }

    update(taskId, updates) {
        const task = this._tasks.get(taskId);
        if (!task) return;
        Object.assign(task, updates, { updated_at: new Date().toISOString() });
    }

    clearBlock(taskId) {
        const task = this._tasks.get(taskId);
        if (!task || task.status !== 'blocked') return false;

        task.status     = 'queued';
        task.updated_at = new Date().toISOString();
        this._pending.unshift(taskId);

        logger.info('Task unblocked', { task_id: taskId, tenant_id: task.tenant_id });

        this._processNext();
        return true;
    }

    complete(taskId, result) {
        const task = this._tasks.get(taskId);
        if (task) {
            task.status     = 'completed';
            task.result     = result;
            task.updated_at = new Date().toISOString();
            logger.info('Task completed', {
                task_id:           taskId,
                tenant_id:         task.tenant_id,
                remaining_running: this._running.size - 1,
            });
            metrics.taskCount.inc({ status: 'completed', tenant_id: task.tenant_id || 'unknown' });
            writeOutboxEvent(`tasks.${task.tenant_id}.events.${taskId}`, { type: 'task-complete', taskId, tenantId: task.tenant_id });
            this.emit('task:complete', task);
        }

        this._releaseSlot(taskId, task);
        this._processNext();
    }

    fail(taskId, error) {
        const task = this._tasks.get(taskId);
        if (task) {
            task.status     = 'failed';
            task.result     = { error: error instanceof Error ? error.message : error };
            task.updated_at = new Date().toISOString();
            logger.error('Task failed', {
                task_id:   taskId,
                tenant_id: task.tenant_id,
                error:     task.result.error,
            });
            metrics.taskCount.inc({ status: 'failed', tenant_id: task.tenant_id || 'unknown' });
            writeOutboxEvent(`tasks.${task.tenant_id}.events.${taskId}`, { type: 'task-failed', taskId, tenantId: task.tenant_id, error: task.result.error });
            this.emit('task:fail', task);
        }

        this._releaseSlot(taskId, task);
        this._processNext();
    }

    block(taskId, reason) {
        const task = this._tasks.get(taskId);
        if (task) {
            task.status     = 'blocked';
            task.result     = { blocked_reason: reason };
            task.updated_at = new Date().toISOString();
            logger.warn('Task blocked', { task_id: taskId, tenant_id: task.tenant_id, reason });
            metrics.taskCount.inc({ status: 'blocked', tenant_id: task.tenant_id || 'unknown' });
            this.emit('task:blocked', task);
        }

        this._releaseSlot(taskId, task);
        this._processNext();
    }

    /**
     * Dynamically update global max concurrency (hot reload).
     * @paramnewMax
     */
    setMaxConcurrency(newMax) {
        const HARD_CAP = 12;
        const oldMax   = this._maxConcurrency;
        this._maxConcurrency = Math.max(1, Math.min(newMax, HARD_CAP));

        logger.info('Concurrency updated', { old: oldMax, new: this._maxConcurrency });

        if (this._maxConcurrency > oldMax) {
            this._processNext();
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Release a worker slot for a task that has finished (any terminal state).
     * @paramtaskId
     * @paramtask - task object (may be null if already removed)
     * @private
     */
    _releaseSlot(taskId, task) {
        this._running.delete(taskId);

        if (task && task.tenant_id) {
            const prev = this._tenantRunning.get(task.tenant_id) || 0;
            if (prev <= 1) {
                this._tenantRunning.delete(task.tenant_id);
            } else {
                this._tenantRunning.set(task.tenant_id, prev - 1);
            }
        }
    }

    /**
     * Drain pending tasks into available worker slots.
     * Skips tasks whose tenant already hit the per-tenant cap.
     * @private
     */
    _processNext() {
        let i = 0;
        while (i < this._pending.length && this._running.size < this._maxConcurrency) {
            const taskId   = this._pending[i];
            const task     = this._tasks.get(taskId);
            const tenantId = task ? task.tenant_id : null;

            const tenantRunning = tenantId ? (this._tenantRunning.get(tenantId) || 0) : 0;

            if (tenantRunning >= this._tenantMaxConcurrency) {
                // This tenant is at its cap; skip to the next pending task
                i++;
                continue;
            }

            // Slot is available for this tenant — remove from pending and start
            this._pending.splice(i, 1);
            this._startTask(taskId);
            // Don't increment i; the splice shifts the array down
        }

        if (this._pending.length === 0 && this._running.size === 0) {
            logger.debug('Queue idle', { maxConcurrency: this._maxConcurrency });
        }
    }

    /**
     * Start a single task and update counters.
     * @paramtaskId
     * @private
     */
    _startTask(taskId) {
        const task = this._tasks.get(taskId);
        if (!task) return;

        task.status     = 'running';
        task.started_at = new Date().toISOString();
        task.updated_at = task.started_at;

        this._running.set(taskId, task);

        // Increment per-tenant counter
        const tenantId = task.tenant_id;
        if (tenantId) {
            this._tenantRunning.set(tenantId, (this._tenantRunning.get(tenantId) || 0) + 1);
        }

        logger.info('Task started', {
            task_id:    taskId,
            tenant_id:  tenantId,
            running:    this._running.size,
            max:        this._maxConcurrency,
            tenant_running: this._tenantRunning.get(tenantId) || 0,
        });

        this.emit('task:start', task);
    }
}

// Create singleton with hardware-aware concurrency
const queue = new TaskQueue(config.MAX_CONCURRENCY, config.TENANT_MAX_CONCURRENCY);

module.exports = queue;

export {};
