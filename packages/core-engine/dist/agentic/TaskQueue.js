"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskQueue = void 0;
class TaskQueue {
    redisPush;
    redisBPop;
    redisPeek;
    tenantIds;
    handlers = [];
    running = false;
    constructor(redisPush, redisBPop, redisPeek, tenantIds) {
        this.redisPush = redisPush;
        this.redisBPop = redisBPop;
        this.redisPeek = redisPeek;
        this.tenantIds = tenantIds;
    }
    queueKey(tenantId) {
        return `task-queue:${tenantId}`;
    }
    /** Enqueue a task for processing. */
    async enqueue(task) {
        await this.redisPush(this.queueKey(task.tenantId), JSON.stringify(task));
    }
    /** Register a handler to process dequeued tasks. */
    onTask(handler) {
        this.handlers.push(handler);
    }
    /**
     * startWorker — begins processing tasks from all tenant queues.
     * Runs until stop() is called. Should be called once in main.ts.
     */
    async startWorker() {
        this.running = true;
        while (this.running) {
            const tenantIds = this.tenantIds();
            if (tenantIds.length === 0) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            const keys = tenantIds.map(t => this.queueKey(t));
            const result = await this.redisBPop(keys, 5);
            if (!result)
                continue; // timeout — loop and re-poll
            const [, raw] = result;
            let task;
            try {
                task = JSON.parse(raw);
            }
            catch (err) {
                console.error(`[TaskQueue] Failed to parse task: ${err.message}`);
                continue;
            }
            for (const handler of this.handlers) {
                try {
                    await handler(task);
                }
                catch (err) {
                    console.error(`[TaskQueue] Handler error for task ${task.id}: ${err.message}`);
                }
            }
        }
    }
    stop() {
        this.running = false;
    }
}
exports.TaskQueue = TaskQueue;
//# sourceMappingURL=TaskQueue.js.map